-- CreateTable
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "site" TEXT,
    "browser" TEXT NOT NULL DEFAULT 'firefox',
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "encoding" TEXT NOT NULL DEFAULT 'base64-archive',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "BrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSession_label_key" ON "BrowserSession"("label");

-- CreateIndex
CREATE INDEX "BrowserSession_site_idx" ON "BrowserSession"("site");

-- CreateIndex
CREATE INDEX "BrowserSession_updatedAt_idx" ON "BrowserSession"("updatedAt");
