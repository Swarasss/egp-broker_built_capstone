import { beforeEach, describe, expect, it, vi } from 'vitest'
import workstationsGet from '../../../../../server/api/cbtf/workstations/index.get'
import outOfServicePost from '../../../../../server/api/cbtf/workstations/[seatNumber]/out-of-service.post'
import returnToServicePost from '../../../../../server/api/cbtf/workstations/[seatNumber]/return-to-service.post'
import sparesPatch from '../../../../../server/api/admin/cbtf/workstations/spares.patch'
import moveSeatPost from '../../../../../server/api/proctor/reservations/[id]/move-seat.post'

vi.mock('@@/server/utils/db', () => ({
  default: {
    cbtfFacility: { findUnique: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn()
  }
}))

vi.mock('h3', async () => ({
  ...(await vi.importActual('h3')),
  defineEventHandler: (handler: any) => handler,
  getQuery: (event: any) => event._query ?? {},
  getRouterParam: (event: any, name: string) => event._params?.[name],
  readBody: (event: any) => Promise.resolve(event._body ?? {}),
  createError: (options: any) => Object.assign(new Error(options.statusMessage || 'Error'), options)
}))

let currentUser: any = null
vi.stubGlobal('getUserSession', () => Promise.resolve({ user: currentUser }))

const event = (options: { query?: any; params?: any; body?: any } = {}) =>
  ({
    _query: options.query ?? {},
    _params: options.params ?? {},
    _body: options.body ?? {},
    context: {}
  }) as any

const handlers = [workstationsGet, outOfServicePost, returnToServicePost, sparesPatch, moveSeatPost]

describe('CBTF workstation endpoints', () => {
  beforeEach(() => {
    currentUser = null
  })

  it('rejects unauthenticated requests with 401', async () => {
    for (const handler of handlers) {
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 401 })
    }
  })

  it('rejects students with 403', async () => {
    currentUser = { id: 'student-1', globalRole: 'USER' }
    for (const handler of handlers) {
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('rejects proctors from changing spare seats', async () => {
    currentUser = { id: 'proctor-1', globalRole: 'PROCTOR' }
    await expect(sparesPatch(event())).rejects.toMatchObject({ statusCode: 403 })
  })
})
