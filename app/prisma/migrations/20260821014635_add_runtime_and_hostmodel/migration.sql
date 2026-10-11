-- CreateTable
CREATE TABLE "Runtime" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT,
    "installMethod" TEXT,
    "serviceState" TEXT,
    "modelPath" TEXT,
    "diskTotalBytes" REAL,
    "diskFreeBytes" REAL,
    "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Runtime_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HostModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "runtimeKind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeBytes" REAL,
    "digest" TEXT,
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HostModel_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Runtime_hostId_kind_key" ON "Runtime"("hostId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "HostModel_hostId_runtimeKind_name_key" ON "HostModel"("hostId", "runtimeKind", "name");
