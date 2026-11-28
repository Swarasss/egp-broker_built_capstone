import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getStudentRedemptions, redeemPass } from '../../../../server/utils/redemptions'
import { getOpenCbtfRetakeWindow } from '@@/server/utils/cbtf-retakes'
import prisma from '@@/server/utils/db'
import { notifyPassRedemption } from '@@/server/services/alert.service'

vi.mock('@@/server/services/alert.service', () => ({
  notifyPassRedemption: vi.fn().mockResolvedValue(true)
}))

vi.mock('@@/server/utils/db', () => ({
  default: {
    passRedemption: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn()
    },
    studentPassPool: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    passType: {
      findUnique: vi.fn()
    },
    user: {
      findUnique: vi.fn()
    },
    assignment: {
      findUnique: vi.fn()
    },
    assignmentOverrideStudent: {
      findFirst: vi.fn()
    },
    enrollment: {
      findUnique: vi.fn()
    },
    assignmentOverride: {
      findFirst: vi.fn()
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((callback) => callback(prisma))
  }
}))

describe('Redemption Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.studentPassPool.updateMany).mockResolvedValue({ count: 1 })
  })

  describe('getStudentRedemptions', () => {
    it('should return mapped redemption rows', async () => {
      const mockRedemptions = [
        {
          id: 'r1',
          assignment: { title: 'A1' },
          createdAt: new Date('2023-01-01'),
          cost: 1,
          availableFrom: null,
          acceptUntil: null,
          pool: {
            passType: { hoursPerPass: 24 }
          }
        }
      ]

      vi.mocked(prisma.passRedemption.findMany).mockResolvedValue(mockRedemptions as any)

      const result = await getStudentRedemptions('u1', 'c1')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('r1')
      expect(result[0].assignmentTitle).toBe('A1')
      expect(result[0].hoursPerPass).toBe(24)
    })
    it('returns CBTF retake state only for an open, usable retry receipt', async () => {
      const base = {
        id: 'r1', assignmentId: 'a1', assignment: { title: 'Same title', courseId: 'c1', isSchedulable: true },
        createdAt: new Date(Date.now() - 60_000), cost: 1,
        availableFrom: null, dueDate: null, acceptUntil: new Date(Date.now() + 60_000),
        cbtfRetake: null,
        pool: { passType: { hoursPerPass: 24, extensionOnly: false, extendsCutoffOnly: false } }
      }
      vi.mocked(prisma.passRedemption.findMany).mockResolvedValue([
        base,
        { ...base, id: 'expired', acceptUntil: base.createdAt },
        { ...base, id: 'used', cbtfRetake: { id: 'attempt', status: 'COMPLETED' } },
        { ...base, id: 'extension', pool: { passType: { ...base.pool.passType, extendsCutoffOnly: true } } },
        { ...base, id: 'missed', cbtfRetake: { id: 'resumable', status: 'MISSED' } }
      ] as any)
      const rows = await getStudentRedemptions('student', 'c1')
      expect(rows.map((row) => [row.assignmentId, row.cbtfRetakeWindow?.reservationId])).toEqual([
        ['a1', null], ['a1', undefined], ['a1', undefined], ['a1', undefined], ['a1', 'resumable']
      ])
    })
  })

  describe('repeated CBTF retake redemptions', () => {
    function setupRetakes(initialBalance: number) {
      let balance = initialBalance
      const receipts: any[] = []
      vi.mocked(prisma.studentPassPool.findUnique).mockImplementation(async () => ({
        id: 'pool1', balance, passType: {
          id: 'retry', courseId: 'course-1', hoursPerPass: 24,
          extensionOnly: false, extendsCutoffOnly: false
        }
      }) as any)
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'exam', courseId: 'course-1', isSchedulable: true, passEligibilities: [{ passTypeId: 'retry' }]
      } as any)
      vi.mocked(prisma.passRedemption.findMany).mockImplementation(async () => [...receipts].reverse())
      vi.mocked(prisma.passRedemption.create).mockImplementation(async ({ data }) => {
        const receipt = {
          ...data, id: `receipt-${receipts.length + 1}`, createdAt: new Date(),
          cbtfRetake: null, assignment: { isSchedulable: true, courseId: 'course-1', title: 'Exam' },
          pool: { passType: { hoursPerPass: 24, extensionOnly: false, extendsCutoffOnly: false } }
        }
        receipts.push(receipt)
        return receipt as any
      })
      vi.mocked(prisma.studentPassPool.updateMany).mockImplementation(async ({ where, data }) => {
        expect(where).toEqual({ id: 'pool1', balance: { gte: 1 } })
        expect(data).toEqual({ balance: { decrement: 1 } })
        if (balance === 0) return { count: 0 }
        balance--
        return { count: 1 }
      })
      // Model the PostgreSQL student row lock, held until the transaction exits.
      let tail = Promise.resolve()
      vi.mocked(prisma.$transaction).mockImplementation((async (run: any) => {
        let unlock: (() => void) | undefined
        const tx = {
          ...prisma,
          $queryRaw: async (query: TemplateStringsArray, ...params: unknown[]) => {
            expect(query.join('?')).toContain('FOR NO KEY UPDATE')
            expect(params).toEqual(['student'])
            const previous = tail
            tail = new Promise<void>((resolve) => { unlock = resolve })
            await previous
            return [{ id: 'student' }]
          }
        }
        try {
          return await run(tx)
        } finally {
          unlock?.()
        }
      }) as any)
      return {
        receipts, balance: () => balance,
        redeem: () => redeemPass('student', 'exam', 'retry')
      }
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2030-01-08T08:00:00Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.mocked(prisma.$transaction).mockImplementation(((run: any) => run(prisma)) as any)
      vi.mocked(prisma.passRedemption.findMany).mockReset()
    })

    it('spends three units on three distinct attempts and keeps prior receipts and claims', async () => {
      const { receipts, balance, redeem } = setupRetakes(3)
      const statuses = ['CHECKED_IN', 'COMPLETED', 'CHECKED_OUT']
      for (const [index, status] of statuses.entries()) {
        const redemption = await redeem()
        expect(redemption).toMatchObject({ id: `receipt-${index + 1}`, cost: 1, assignmentId: 'exam' })
        expect(balance()).toBe(2 - index)
        const receipt = receipts[index]
        expect(getOpenCbtfRetakeWindow(receipt, new Date())).not.toBeNull()
        expect((await getStudentRedemptions('student', 'course-1'))[0]?.cbtfRetakeRedemptionBlockedUntil)
          .toBe(receipt.acceptUntil.toISOString())

        await expect(redeem()).rejects.toThrow(index === 2 ? 'Insufficient pass balance' : 'active retake redemption')
        expect(balance()).toBe(2 - index)
        receipt.cbtfRetake = {
          id: `attempt-${index + 1}`, status, checkedInAt: status === 'CHECKED_IN' ? new Date() : null
        }
        expect(getOpenCbtfRetakeWindow(receipt, new Date())).toBeNull()
        expect((await getStudentRedemptions('student', 'course-1'))[0]?.cbtfRetakeRedemptionBlockedUntil).toBeNull()
      }
      await expect(redeem()).rejects.toThrow('Insufficient pass balance')
      expect(balance()).toBe(0)
      expect(receipts.map(({ id, cbtfRetake }) => [id, cbtfRetake.id, cbtfRetake.status])).toEqual([
        ['receipt-1', 'attempt-1', 'CHECKED_IN'],
        ['receipt-2', 'attempt-2', 'COMPLETED'],
        ['receipt-3', 'attempt-3', 'CHECKED_OUT']
      ])
      expect(prisma.studentPassPool.updateMany).toHaveBeenCalledTimes(3)
    })

    it.each(['SCHEDULED', 'CANCELLED', 'MISSED'])(
      'keeps an unconsumed %s attempt on its existing receipt without another debit', async (status) => {
        const { receipts, balance, redeem } = setupRetakes(3)
        await redeem()
        const receipt = receipts[0]
        receipt.cbtfRetake = { id: 'attempt-1', status }
        expect(getOpenCbtfRetakeWindow(receipt, new Date(), 'attempt-1')).not.toBeNull()
        expect((await getStudentRedemptions('student', 'course-1'))[0]?.cbtfRetakeRedemptionBlockedUntil)
          .toBe(receipt.acceptUntil.toISOString())
        await expect(redeem()).rejects.toThrow('active retake redemption')
        expect(balance()).toBe(2)
        expect(receipts).toHaveLength(1)
        expect(prisma.studentPassPool.updateMany).toHaveBeenCalledOnce()
      }
    )

    it.each([1, 3])('allows only one concurrent redemption with balance %i', async (initialBalance) => {
      const { receipts, balance, redeem } = setupRetakes(initialBalance)
      const results = await Promise.allSettled([redeem(), redeem()])
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(receipts).toHaveLength(1)
      expect(balance()).toBe(initialBalance - 1)
      expect(prisma.studentPassPool.updateMany).toHaveBeenCalledOnce()
    })
  })

  describe('redeemPass', () => {
    it('throws error if existing pass pool balance is 0', async () => {
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue({
        id: 'pool1',
        balance: 0,
        passType: { id: 'pt1', hoursPerPass: 24, extensionOnly: true }
      } as any)

      await expect(redeemPass('u1', 'a1', 'pt1')).rejects.toThrow('Insufficient pass balance')
    })

    it('throws 404 if pool not found and pass type does not exist', async () => {
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.passType.findUnique).mockResolvedValue(null)

      await expect(redeemPass('u1', 'a1', 'pt1')).rejects.toThrow('Pass type not found')
    })

    it('lazily provisions pool with initialBalance when pool does not exist yet', async () => {
      const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.passType.findUnique).mockResolvedValue({
        id: 'pt1',
        name: 'Late Pass',
        initialBalance: 3,
        hoursPerPass: 24,
        extensionOnly: true,
        courseId: 'c1',
        course: { id: 'c1', name: 'Course 1' }
      } as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        ltiIdentities: []
      } as any)

      const createdPool = {
        id: 'new-pool',
        userId: 'u1',
        passTypeId: 'pt1',
        balance: 3,
        passType: {
          id: 'pt1',
          name: 'Late Pass',
          hoursPerPass: 24,
          extensionOnly: true,
          courseId: 'c1',
          course: { id: 'c1', name: 'Course 1' }
        },
        user: { id: 'u1', email: 'user@example.com', ltiIdentities: [] }
      }
      vi.mocked(prisma.studentPassPool.create).mockResolvedValue(createdPool as any)

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'a1',
        dueDate,
        acceptUntil: dueDate,
        passEligibilities: [{ passTypeId: 'pt1' }]
      } as any)

      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.passRedemption.create).mockResolvedValue({
        id: 'r1',
        cost: 1
      } as any)

      const result = await redeemPass('u1', 'a1', 'pt1')

      expect(prisma.studentPassPool.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: 'u1',
            passTypeId: 'pt1',
            balance: 3
          }
        })
      )
      expect(result.id).toBe('r1')
      expect(prisma.studentPassPool.updateMany).toHaveBeenCalledWith({
        where: { id: 'new-pool', balance: { gte: 1 } },
        data: { balance: { decrement: 1 } }
      })
    })

    it('throws error if assignment is not eligible for pass type', async () => {
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue({
        id: 'pool1',
        balance: 3,
        passType: { id: 'pt1', hoursPerPass: 24, extensionOnly: true }
      } as any)

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'a1',
        passEligibilities: []
      } as any)

      await expect(redeemPass('u1', 'a1', 'pt1')).rejects.toThrow('Assignment is not eligible')
    })

    it('successfully redeems extension pass and deducts cost', async () => {
      const dueDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue({
        id: 'pool1',
        balance: 3,
        passType: {
          id: 'pt1',
          hoursPerPass: 24,
          extensionOnly: true,
          minDaysPastDue: 0,
          maxDaysPastDue: null
        }
      } as any)

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'a1',
        dueDate,
        acceptUntil: dueDate,
        passEligibilities: [{ passTypeId: 'pt1' }]
      } as any)

      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.passRedemption.create).mockResolvedValue({
        id: 'r1',
        cost: 1
      } as any)

      const result = await redeemPass('u1', 'a1', 'pt1')

      expect(result.id).toBe('r1')
      expect(prisma.passRedemption.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          poolId: 'pool1',
          assignmentId: 'a1',
          cost: 1
        })
      })
      expect(prisma.studentPassPool.updateMany).toHaveBeenCalledWith({
        where: { id: 'pool1', balance: { gte: 1 } },
        data: { balance: { decrement: 1 } }
      })
      expect(notifyPassRedemption).toHaveBeenCalledWith(
        expect.objectContaining({
          cost: 1
        })
      )
    })

    it('allows at most one receipt when two concurrent requests read a one-pass balance', async () => {
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue({
        id: 'pool1', balance: 1,
        passType: { id: 'pt1', hoursPerPass: 24, extensionOnly: false }
      } as any)
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'a1', passEligibilities: [{ passTypeId: 'pt1' }]
      } as any)
      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.passRedemption.create).mockResolvedValue({ id: 'winner' } as any)

      let balance = 1
      vi.mocked(prisma.studentPassPool.updateMany).mockImplementation(async ({ where, data }) => {
        expect(where).toEqual({ id: 'pool1', balance: { gte: 1 } })
        expect(data).toEqual({ balance: { decrement: 1 } })
        if (!balance) return { count: 0 }
        balance--
        return { count: 1 }
      })

      const results = await Promise.allSettled([
        redeemPass('u1', 'a1', 'pt1'), redeemPass('u1', 'a1', 'pt1')
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { statusCode: 400, statusMessage: 'Insufficient pass balance' }
      })
      expect(prisma.passRedemption.create).toHaveBeenCalledOnce()
      expect(balance).toBe(0)
    })

    it('throws error if balance is insufficient for multi-pass catch-up cost', async () => {
      // Due 10 days ago, with 24h passType -> requires 10+ passes
      const oldDueDate = new Date('2020-01-01T00:00:00.000Z')
      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue({
        id: 'pool1',
        balance: 1, // Only 1 pass available
        passType: {
          id: 'pt1',
          hoursPerPass: 24,
          extensionOnly: true,
          minDaysPastDue: null,
          maxDaysPastDue: null
        }
      } as any)

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'a1',
        dueDate: oldDueDate,
        acceptUntil: oldDueDate,
        passEligibilities: [{ passTypeId: 'pt1' }]
      } as any)

      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)

      await expect(redeemPass('u1', 'a1', 'pt1')).rejects.toThrow(/Insufficient pass balance/)
    })

    it('redeems pass successfully using student override baseline', async () => {
      const baseDueDate = new Date('2020-01-01T00:00:00.000Z') // Base assignment due long ago
      const overrideDueDate = new Date(Date.now() + 24 * 60 * 60 * 1000) // But student accommodation is tomorrow

      vi.mocked(prisma.studentPassPool.findUnique).mockResolvedValue({
        id: 'pool1',
        balance: 1,
        passType: {
          id: 'pt1',
          hoursPerPass: 24,
          extensionOnly: true,
          courseId: 'c1'
        }
      } as any)

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'a1',
        dueDate: baseDueDate,
        acceptUntil: baseDueDate,
        passEligibilities: [{ passTypeId: 'pt1' }]
      } as any)

      // Student has accommodation override
      vi.mocked(prisma.assignmentOverrideStudent.findFirst).mockResolvedValue({
        override: {
          dueDate: overrideDueDate,
          acceptUntil: overrideDueDate,
          availableFrom: null,
          title: 'SDS Accommodation'
        }
      } as any)

      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.passRedemption.create).mockResolvedValue({ id: 'r2', cost: 1 } as any)

      const result = await redeemPass('u1', 'a1', 'pt1')
      expect(result.id).toBe('r2')
      expect(prisma.passRedemption.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cost: 1
        })
      })
    })
  })
})
