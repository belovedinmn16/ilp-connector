import { loadModuleOfType, composeMiddleware } from '../lib/utils'
import {
  Middleware,
  MiddlewareDefinition,
  MiddlewareMethod,
  MiddlewareConstructor,
  Pipeline,
  Pipelines, MiddlewareServices
} from '../types/middleware'
import { MoneyHandler, VoidHandler } from '../types/plugin'
import MiddlewarePipeline from '../lib/middleware-pipeline'
import { IlpPrepare, IlpReply, IlpPacketHander } from 'ilp-packet'
import Stats from './stats'
import Config from './config'

const BUILTIN_MIDDLEWARES: { [key: string]: MiddlewareDefinition } = {
  errorHandler: {
    type: 'error-handler'
  },
  rateLimit: {
    type: 'rate-limit'
  },
  throughput: {
    type: 'throughput'
  },
  balance: {
    type: 'balance'
  },
  expire: {
    type: 'expire'
  }
}

export default class MiddlewareManager {
  protected config: Config
  protected middlewares: { [key: string]: Middleware }
  protected stats: Stats

  constructor (services: MiddlewareServices) {
    this.config = services.config
    this.stats = services.stats

    const disabledMiddlewareConfig: string[] = this.config.disableMiddleware || []
    const customMiddlewareConfig: { [key: string]: MiddlewareDefinition } = this.config.middlewares || {}

    this.middlewares = {}

    for (const name of Object.keys(BUILTIN_MIDDLEWARES)) {
      if (disabledMiddlewareConfig.includes(name)) {
        continue
      }

      this.middlewares[name] = this.construct(name, BUILTIN_MIDDLEWARES[name], services)
    }

    for (const name of Object.keys(customMiddlewareConfig)) {
      if (this.middlewares[name]) {
        throw new Error('custom middleware has same name as built-in middleware. name=' + name)
      }

      this.middlewares[name] = this.construct(name, customMiddlewareConfig[name], services)
    }
  }

  construct (name: string, definition: MiddlewareDefinition, services: MiddlewareServices): Middleware {
    // Custom middleware
    const Middleware: MiddlewareConstructor =
      loadModuleOfType('middleware', definition.type)

    return new Middleware(definition.options || {}, services)
  }

  public async setupHandlers (accountid: string, handlers: {
    outgoingMoney: MoneyHandler,
    outgoingIlpPacket: IlpPacketHander,
    incomingMoney: MoneyHandler,
    incomingIlpPacket: IlpPacketHander
  }): Promise<{
    startupPipeline: VoidHandler
    outgoingIlpPacketPipeline: IlpPacketHander,
    outgoingMoneyPipeline: MoneyHandler
    incomingIlpPacketPipeline: IlpPacketHander,
    incomingMoneyPipeline: MoneyHandler
    shutdownPipeline: VoidHandler
  }> {
    const {
      outgoingMoney,
      outgoingIlpPacket,
      incomingMoney,
      incomingIlpPacket
    } = handlers
    const pipelines: Pipelines = {
      startup: new MiddlewarePipeline<void, void>(),
      incomingData: new MiddlewarePipeline<IlpPrepare, IlpReply>(),
      incomingMoney: new MiddlewarePipeline<string, void>(),
      outgoingData: new MiddlewarePipeline<IlpPrepare, IlpReply>(),
      outgoingMoney: new MiddlewarePipeline<string, void>(),
      shutdown: new MiddlewarePipeline<void, void>()
    }
    for (const middlewareName of Object.keys(this.middlewares)) {
      const middleware = this.middlewares[middlewareName]
      try {
        await middleware.applyToPipelines(pipelines, accountid)
      } catch (err) {
        const errInfo = (err && typeof err === 'object' && err.stack) ? err.stack : String(err)

        console.log('failed to apply middleware middlewareName=%s error=%s', middlewareName, errInfo)
        throw new Error('failed to apply middleware. middlewareName=' + middlewareName)
      }
    }

    // Generate startup middleware
    const startupPipeline = this.createHandler(pipelines.startup, async () => { return })

    // Generate outgoing middleware (ILP prepare from connector to plugin)
    const outgoingIlpPacketPipeline = this.createHandler(pipelines.outgoingData, outgoingIlpPacket)
    const outgoingMoneyPipeline = this.createHandler(pipelines.outgoingMoney, outgoingMoney)

    // Generate incoming middleware (ILP Prepare from plugin to connector)
    const incomingIlpPacketPipeline = this.createHandler(pipelines.incomingData, incomingIlpPacket)
    const incomingMoneyPipeline = this.createHandler(pipelines.incomingMoney, incomingMoney)

    // Generate shutdown middleware
    const shutdownPipeline = this.createHandler(pipelines.shutdown, async () => { return })

    return {
      startupPipeline,
      outgoingIlpPacketPipeline,
      outgoingMoneyPipeline,
      incomingIlpPacketPipeline,
      incomingMoneyPipeline,
      shutdownPipeline
    }
  }

  private createHandler<T,U> (pipeline: Pipeline<T,U>, next: (param: T) => Promise<U>): (param: T) => Promise<U> {
    const middleware: MiddlewareMethod<T,U> = composeMiddleware(pipeline.getMethods())
    return (param: T) => middleware(param, next)
  }
}
