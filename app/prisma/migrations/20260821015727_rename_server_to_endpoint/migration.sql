-- Rename the table. SQLite rewrites foreign-key references in other tables
-- automatically, so Log's FK follows.
ALTER TABLE "Server" RENAME TO "Endpoint";

-- New column for the engine discriminator.
ALTER TABLE "Endpoint" ADD COLUMN "engine" TEXT NOT NULL DEFAULT 'ollama';

-- Rename the referencing column. SQLite updates index definitions that mention
-- it, but not their names, so the index is recreated below under the name
-- Prisma expects.
ALTER TABLE "Log" RENAME COLUMN "serverId" TO "endpointId";

DROP INDEX IF EXISTS "Log_serverId_createdAt_idx";
CREATE INDEX "Log_endpointId_createdAt_idx" ON "Log"("endpointId", "createdAt");

-- Implicit many-to-many join table for Endpoint <-> Host.
CREATE TABLE "_EndpointToHost" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_EndpointToHost_A_fkey" FOREIGN KEY ("A") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_EndpointToHost_B_fkey" FOREIGN KEY ("B") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "_EndpointToHost_AB_unique" ON "_EndpointToHost"("A", "B");
CREATE INDEX "_EndpointToHost_B_index" ON "_EndpointToHost"("B");
