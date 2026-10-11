#!/usr/bin/env bash
set -euo pipefail

# Installs and enables the zllama fleet agent as a systemd service.
#
# One command enrolls a host: the agent source is downloaded from the zllama
# server passed in --server, so nothing has to be copied onto the machine
# beforehand.
#
# Idempotent: re-running this script upgrades an existing install in place
# (re-downloads the source, reinstalls into the venv, rewrites the config,
# reinstalls and restarts the unit). Run as root.
#
# Usage:
#   sudo ./install.sh --token <enrollment-token> --server <https://zllama-host> [--interval 30s] \
#     [--vllm-model-path /srv/models] [--vllm-model-path /mnt/other-models]
#
# Or piped straight from the server, one command per host:
#   curl -fsSL <https://zllama-host>/api/agent/install | sudo bash -s -- \
#     --token <enrollment-token> --server <https://zllama-host>
#
# --vllm-model-path is optional and repeatable: each occurrence adds one
# directory to agent.yaml's vllm_model_paths list, scanned alongside the
# managed HF cache for vLLM's on-disk model inventory (see facts.py).
#
# Must be run with bash, not a plain POSIX shell: the `set -euo pipefail`
# above uses a bash-only option, which a dash-backed /bin/sh (Ubuntu's
# default) rejects immediately with "set: Illegal option -o pipefail".
#
# The token is never baked into this script, and never served by zllama. It is
# only ever passed on the command line and written to a mode-0600 config file.

TOKEN=""
SERVER=""
INTERVAL="30s"
VLLM_MODEL_PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --server)
      SERVER="${2:-}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    --vllm-model-path)
      VLLM_MODEL_PATHS+=("${2:-}")
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TOKEN" ]]; then
  echo "Error: --token is required (get it from a zllama admin)" >&2
  exit 1
fi

if [[ -z "$SERVER" ]]; then
  echo "Error: --server is required, e.g. --server https://zllama.example" >&2
  exit 1
fi

INSTALL_DIR="/opt/zllama-agent"
SRC_DIR="${INSTALL_DIR}/agent"
VENV_DIR="${INSTALL_DIR}/venv"
CONFIG_DIR="/etc/zllama"
CONFIG_FILE="${CONFIG_DIR}/agent.yaml"
UNIT_FILE="/etc/systemd/system/zllama-agent.service"
PACKAGE_URL="${SERVER}/api/agent/package"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    echo "Error: neither curl nor wget is available to download the agent" >&2
    exit 1
  fi
}

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"

# Fetch the agent source from the server this host will report to, rather than
# requiring the operator to copy the tree over first.
echo "Downloading the zllama agent from ${PACKAGE_URL}..."
rm -rf "$SRC_DIR"
download "$PACKAGE_URL" | tar -xzf - -C "$INSTALL_DIR"

if [[ ! -f "${SRC_DIR}/pyproject.toml" ]]; then
  echo "Error: downloaded agent package is missing pyproject.toml" >&2
  exit 1
fi

# A venv directory existing is not proof it's usable: if a previous run's
# `python3 -m venv` created the directory but ensurepip failed partway
# through, `bin/pip` never gets written and a bare "already exists" check
# leaves this re-run pinned to the broken venv, dying later at
# `pip: No such file or directory`. Recreate it from scratch instead.
if [[ -d "$VENV_DIR" && ! -x "${VENV_DIR}/bin/pip" ]]; then
  echo "Existing venv at ${VENV_DIR} has no working bin/pip (a previous ensurepip likely failed); removing and recreating it." >&2
  rm -rf "$VENV_DIR"
fi

if [[ ! -d "$VENV_DIR" ]]; then
  if ! python3 -m venv "$VENV_DIR"; then
    # Common on fresh Ubuntu hosts: Debian/Ubuntu ship the `venv`
    # module in a separate package keyed to the exact Python minor version,
    # and `python3 -m venv` fails with an opaque traceback when it's
    # missing. Name the exact package for this host's Python rather than
    # leaving the operator to guess or hardcoding a version that goes stale
    # on the next Ubuntu release.
    PYTHON_MINOR="$(python3 -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo "X")"
    VENV_PACKAGE="python3.${PYTHON_MINOR}-venv"
    echo "Error: 'python3 -m venv' failed. This usually means the venv module isn't installed for this Python." >&2
    echo "Install it with: sudo apt-get install ${VENV_PACKAGE}" >&2
    exit 1
  fi
fi

"${VENV_DIR}/bin/pip" install --upgrade pip >/dev/null
"${VENV_DIR}/bin/pip" install --upgrade "$SRC_DIR"

# A freshly enrolled host reports facts and changes nothing until the
# operator opts it into convergence — converge: false is not optional here.
umask 077
cat > "$CONFIG_FILE" <<EOF
server: ${SERVER}
token: ${TOKEN}
interval: ${INTERVAL}
converge: false
log_level: info
EOF

# Repeatable --vllm-model-path flags become a YAML list; omitted entirely
# when none were given, matching agent.yaml's config.py default of [].
if [[ ${#VLLM_MODEL_PATHS[@]} -gt 0 ]]; then
  echo "vllm_model_paths:" >> "$CONFIG_FILE"
  for model_path in "${VLLM_MODEL_PATHS[@]}"; do
    printf '  - %s\n' "$model_path" >> "$CONFIG_FILE"
  done
fi

chmod 0600 "$CONFIG_FILE"

cp "${SRC_DIR}/systemd/zllama-agent.service" "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable zllama-agent.service
systemctl restart zllama-agent.service

echo "zllama-agent installed and running against ${SERVER}."
echo "Next step: approve this host in the zllama admin UI under Hosts."
