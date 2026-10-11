/*
  Warnings:

  - You are about to drop the column `gpuAgentUrl` on the `Endpoint` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Endpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'ollama',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Endpoint" ("active", "createdAt", "engine", "id", "name", "url") SELECT "active", "createdAt", "engine", "id", "name", "url" FROM "Endpoint";
DROP TABLE "Endpoint";
ALTER TABLE "new_Endpoint" RENAME TO "Endpoint";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
