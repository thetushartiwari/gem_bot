-- CreateTable
CREATE TABLE "BrowserCredential" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "site" TEXT,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserCredential_label_key" ON "BrowserCredential"("label");

-- CreateIndex
CREATE INDEX "BrowserCredential_site_idx" ON "BrowserCredential"("site");

-- CreateIndex
CREATE INDEX "BrowserCredential_updatedAt_idx" ON "BrowserCredential"("updatedAt");
