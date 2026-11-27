-- AlterTable
ALTER TABLE "CbtfFacility"
  ADD COLUMN "spareSeatCount" INTEGER,
  ADD COLUMN "spareSeatNumbers" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "reassignThresholdMinutes" INTEGER NOT NULL DEFAULT 60;

-- CreateTable
CREATE TABLE "CbtfSeatStatus" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "isDisabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "disabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CbtfSeatStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CbtfSeatStatus_facilityId_idx" ON "CbtfSeatStatus"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "CbtfSeatStatus_facilityId_seatNumber_key" ON "CbtfSeatStatus"("facilityId", "seatNumber");

-- AddForeignKey
ALTER TABLE "CbtfSeatStatus" ADD CONSTRAINT "CbtfSeatStatus_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "CbtfFacility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
