ALTER TABLE "CbtfReservation" ADD COLUMN "retakeRedemptionId" TEXT;

CREATE UNIQUE INDEX "CbtfReservation_retakeRedemptionId_key"
  ON "CbtfReservation"("retakeRedemptionId");

ALTER TABLE "CbtfReservation" ADD CONSTRAINT "CbtfReservation_retakeRedemptionId_fkey"
  FOREIGN KEY ("retakeRedemptionId") REFERENCES "PassRedemption"("id") ON DELETE SET NULL ON UPDATE CASCADE;
