-- CreateTable
CREATE TABLE "Host" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Gpu" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "vendor" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memoryTotalBytes" REAL,
    "memorySource" TEXT NOT NULL,
    "driverVersion" TEXT,
    "driverStatus" TEXT NOT NULL DEFAULT 'ok',
    "lastUtilPct" REAL,
    "lastTempC" REAL,
    "lastPowerW" REAL,
    "lastMemoryUsedBytes" REAL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Gpu_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Host_nodeName_key" ON "Host"("nodeName");

-- CreateIndex
CREATE UNIQUE INDEX "Gpu_hostId_index_key" ON "Gpu"("hostId", "index");
