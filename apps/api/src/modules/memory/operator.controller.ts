import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import {
  operatorActivateSchema,
  operatorStageSchema,
} from "@milyonuse/contracts";
import { RateLimit } from "../../common/rate-limit.js";
import { IdempotencyExempt } from "../tenancy/idempotency.js";
import { MemoryService } from "./memory.service.js";

/**
 * An operator's T0 memory: policy an operator signs for one organization.
 *
 * No session reaches these routes and none is needed: the Ed25519 signature
 * over the claim is the authentication, verified against the public keys in
 * MEMORY_OPERATOR_KEYS — the private keys never touch this host, so even a
 * full compromise of it cannot mint a T0. Staging and activating are two
 * signatures, at least five minutes apart (0007).
 */
@Controller("operator/memory")
export class OperatorController {
  constructor(private readonly memory: MemoryService) {}

  @Post("stage")
  @HttpCode(201)
  @IdempotencyExempt(
    "Authenticated by the signature itself; a repeat stages a second claim the operator sees.",
  )
  @RateLimit({ limit: 20, windowSec: 3600, per: "address" })
  async stage(@Body() body: unknown): Promise<{ id: string }> {
    return this.memory.stageOperator(operatorStageSchema.parse(body));
  }

  @Post("activate")
  @HttpCode(200)
  @IdempotencyExempt(
    "Authenticated by the signature itself; activating twice is refused by the lifecycle.",
  )
  @RateLimit({ limit: 20, windowSec: 3600, per: "address" })
  async activate(
    @Body() body: unknown,
  ): Promise<{ id: string; state: "active" }> {
    return this.memory.activateOperator(operatorActivateSchema.parse(body));
  }
}
