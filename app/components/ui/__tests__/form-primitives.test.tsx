import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Input } from "../input";
import { Textarea } from "../textarea";
import { Switch } from "../switch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

describe("form primitives label association", () => {
  it("associates label and input via a generated id when neither id nor name is given", () => {
    render(<Input label="Server name" />);
    const label = container.querySelector("label")!;
    const input = container.querySelector("input")!;
    expect(input.id).toBeTruthy();
    expect(label.getAttribute("for")).toBe(input.id);
  });

  it("prefers an explicit id over the generated fallback", () => {
    render(<Input label="Server name" id="explicit-id" />);
    const input = container.querySelector("input")!;
    expect(input.id).toBe("explicit-id");
    expect(container.querySelector("label")!.getAttribute("for")).toBe("explicit-id");
  });

  it("wires aria-describedby to the error message even without an id or name", () => {
    render(<Input label="Server name" error="Required" />);
    const input = container.querySelector("input")!;
    const describedBy = input.getAttribute("aria-describedby")!;
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)!.textContent).toBe("Required");
  });

  it("associates the textarea label and error via a generated id", () => {
    render(<Textarea label="Notes" error="Too long" />);
    const textarea = container.querySelector("textarea")!;
    expect(container.querySelector("label")!.getAttribute("for")).toBe(textarea.id);
    const describedBy = textarea.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)!.textContent).toBe("Too long");
  });

  it("associates the switch label with its checkbox via a generated id", () => {
    render(<Switch label="Enable telemetry" />);
    const input = container.querySelector("input")!;
    expect(input.id).toBeTruthy();
    expect(container.querySelector("label")!.getAttribute("for")).toBe(input.id);
  });
});
