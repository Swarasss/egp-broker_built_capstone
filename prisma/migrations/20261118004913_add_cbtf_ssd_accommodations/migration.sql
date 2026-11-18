-- CreateTable
CREATE TABLE "CbtfSeat" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "properties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CbtfSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CbtfStudentAccommodation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requiredSeatProperties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CbtfStudentAccommodation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CbtfSeat_facilityId_idx" ON "CbtfSeat"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "CbtfSeat_facilityId_seatNumber_key" ON "CbtfSeat"("facilityId", "seatNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CbtfStudentAccommodation_userId_key" ON "CbtfStudentAccommodation"("userId");

-- CreateIndex
CREATE INDEX "CbtfStudentAccommodation_userId_idx" ON "CbtfStudentAccommodation"("userId");

-- AddForeignKey
ALTER TABLE "CbtfSeat" ADD CONSTRAINT "CbtfSeat_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "CbtfFacility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CbtfStudentAccommodation" ADD CONSTRAINT "CbtfStudentAccommodation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CbtfStudentAccommodation" ADD CONSTRAINT "CbtfStudentAccommodation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
