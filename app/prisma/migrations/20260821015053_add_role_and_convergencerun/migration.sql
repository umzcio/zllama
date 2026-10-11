-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "desiredState" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ConvergenceRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "currentAction" TEXT,
    "progressPct" REAL,
    "actions" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    CONSTRAINT "ConvergenceRun_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Host" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeName" TEXT NOT NULL,
    "address" TEXT,
    "arch" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "kernel" TEXT,
    "cpuModel" TEXT,
    "cpuCount" INTEGER,
    "ramTotalBytes" REAL,
    "converge" BOOLEAN NOT NULL DEFAULT false,
    "approvalState" TEXT NOT NULL DEFAULT 'pending',
    "agentVersion" TEXT,
    "lastCheckInAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'online',
    "statusDetail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "roleId" TEXT,
    CONSTRAINT "Host_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Host" ("address", "agentVersion", "approvalState", "arch", "converge", "cpuCount", "cpuModel", "createdAt", "id", "kernel", "lastCheckInAt", "nodeName", "os", "ramTotalBytes", "status", "statusDetail") SELECT "address", "agentVersion", "approvalState", "arch", "converge", "cpuCount", "cpuModel", "createdAt", "id", "kernel", "lastCheckInAt", "nodeName", "os", "ramTotalBytes", "status", "statusDetail" FROM "Host";
DROP TABLE "Host";
ALTER TABLE "new_Host" RENAME TO "Host";
CREATE UNIQUE INDEX "Host_nodeName_key" ON "Host"("nodeName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE INDEX "ConvergenceRun_hostId_startedAt_idx" ON "ConvergenceRun"("hostId", "startedAt");
