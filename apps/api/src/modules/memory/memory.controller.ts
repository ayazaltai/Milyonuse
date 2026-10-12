import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type MemoryDetailView,
  type MemoryItemView,
  type MemoryLedgerStatus,
  type MemoryListView,
  type MemoryRevocationPreview,
  type Principal,
  memoryCreateSchema,
  memoryForgetSchema,
  memoryListQuerySchema,
  memoryRevokeSourceSchema,
  ulidSchema,
} from "@milyonuse/contracts";
import { z } from "zod";
import { RateLimit } from "../../common/rate-limit.js";
import { SessionGuard } from "../identity/session.guard.js";
import {
  PermissionGuard,
  RequirePermission,
} from "../tenancy/guards/permission.guard.js";
import { CurrentPrincipal } from "../tenancy/guards/principal.decorator.js";
import { PrincipalGuard } from "../tenancy/guards/principal.guard.js";
import { IdempotencyExempt, Idempotent } from "../tenancy/idempotency.js";
import { MemoryService } from "./memory.service.js";

/**
 * The person's memory (the Memory page): what the agent remembers, why it
 * knows it, and what the person decides — approve, reaffirm, forget, withdraw
 * a source. Read and changed in the person's own scope only.
 */
@Controller("memory")
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission("agents.use")
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<MemoryListView> {
    return this.memory.list(
      principal,
      memoryListQuerySchema.parse(query ?? {}),
    );
  }

  /** The person adds a memory in their own words; it is checked like any other. */
  @Post()
  @Idempotent()
  @RateLimit({ limit: 30, windowSec: 600, per: "member" })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<MemoryItemView> {
    return this.memory.create(principal, memoryCreateSchema.parse(body));
  }

  /** Whether the ledger's chain holds, recomputed now. */
  @Get("ledger")
  async ledger(
    @CurrentPrincipal() principal: Principal,
  ): Promise<MemoryLedgerStatus> {
    return this.memory.ledgerStatus(principal);
  }

  /** What withdrawing a source would take, before anyone does it. */
  @Get("revocations/preview")
  async preview(
    @CurrentPrincipal() principal: Principal,
    @Query("sourceUri") sourceUri: unknown,
  ): Promise<MemoryRevocationPreview> {
    return this.memory.revocationPreview(
      principal,
      z.string().trim().min(1).max(2000).parse(sourceUri),
    );
  }

  /** Withdraws a source: every memory from it, and built on it, is revoked at once. */
  @Post("revocations")
  @HttpCode(200)
  @IdempotencyExempt("Withdrawing a source again revokes nothing more.")
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<{ revoked: string[]; skills: string[] }> {
    const input = memoryRevokeSourceSchema.parse(body);
    return this.memory.revokeSource(principal, input.sourceUri, input.reason);
  }

  /** "Why do you know this?" */
  @Get(":memoryId")
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryDetailView> {
    return this.memory.detail(principal, ulidSchema.parse(memoryId));
  }

  @Post(":memoryId/approve")
  @HttpCode(200)
  @IdempotencyExempt("Approving an approved memory changes nothing.")
  async approve(
    @CurrentPrincipal() principal: Principal,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryItemView> {
    return this.memory.approve(principal, ulidSchema.parse(memoryId));
  }

  /** A team's or an agent's memory, taken as the person's own — proposed again in their words. */
  @Post(":memoryId/adopt")
  @HttpCode(200)
  @IdempotencyExempt(
    "Adopting the same memory again finds it already known; nothing is stored twice.",
  )
  async adopt(
    @CurrentPrincipal() principal: Principal,
    @Param("memoryId") memoryId: string,
  ) {
    return this.memory.adopt(principal, ulidSchema.parse(memoryId));
  }

  @Post(":memoryId/reaffirm")
  @HttpCode(200)
  @IdempotencyExempt(
    "A reaffirmation is limited to one a day by the service; a repeat is refused, not stored.",
  )
  async reaffirm(
    @CurrentPrincipal() principal: Principal,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryItemView> {
    return this.memory.reaffirm(principal, ulidSchema.parse(memoryId));
  }

  /** Forgets a memory, and everything built on it. */
  @Post(":memoryId/forget")
  @HttpCode(200)
  @IdempotencyExempt("Forgetting a forgotten memory revokes nothing more.")
  async forget(
    @CurrentPrincipal() principal: Principal,
    @Param("memoryId") memoryId: string,
    @Body() body: unknown,
  ): Promise<{ revoked: string[] }> {
    return this.memory.forget(
      principal,
      ulidSchema.parse(memoryId),
      memoryForgetSchema.parse(body ?? {}).reason,
    );
  }

  /** Keeps a memory the agent asked to forget. */
  @Post(":memoryId/keep")
  @HttpCode(200)
  @IdempotencyExempt("Keeping a memory twice keeps it once.")
  async keep(
    @CurrentPrincipal() principal: Principal,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryItemView> {
    return this.memory.keep(principal, ulidSchema.parse(memoryId));
  }
}
