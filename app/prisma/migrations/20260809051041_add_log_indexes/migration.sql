-- CreateIndex
CREATE INDEX "Log_createdAt_idx" ON "Log"("createdAt");

-- CreateIndex
CREATE INDEX "Log_serverId_createdAt_idx" ON "Log"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "Log_model_idx" ON "Log"("model");

-- CreateIndex
CREATE INDEX "Log_apiKeyId_idx" ON "Log"("apiKeyId");
