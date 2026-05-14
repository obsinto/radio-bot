import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import {
  type CommandAction,
  type CommandPayload,
  type CommandRecord,
  type DashboardState,
  type Device,
  type SafeDevice,
  type SafeSiteProfile,
  type SafeWolGateway,
  type SiteProfile,
  type WolGateway,
  type WolGatewayCommand,
  toSafeDevice,
  toSafeProfile,
  toSafeWolGateway
} from "@radio-bot/shared";
import type { AppConfig } from "./config.js";
import { decryptSecret, encryptSecret, hashToken, safeEqual } from "./crypto.js";

const WOL_GATEWAY_FRESH_MS = 45000;

type DeviceRow = QueryResultRow & {
  id: string;
  name: string;
  location: string;
  token_hash: string;
  profile_ids: string[] | null;
  status: string;
  last_seen_at: Date | string | null;
  current_profile_id: string | null;
  active_url: string | null;
  title: string | null;
  mac_address: string | null;
  broadcast_address: string | null;
  wol_gateway_id: string | null;
};

type WolGatewayRow = QueryResultRow & {
  id: string;
  name: string;
  location: string;
  token_hash: string;
  status: string;
  last_seen_at: Date | string | null;
};

type ProfileRow = QueryResultRow & {
  id: string;
  name: string;
  site_url: string;
  username_cipher: string;
  password_cipher: string;
};

type CommandRow = QueryResultRow & {
  id: string;
  action: CommandAction;
  profile_id: string;
  device_id: string;
  requested_by: string;
  payload: CommandPayload | string;
  status: CommandRecord["status"];
  created_at: Date | string;
  updated_at: Date | string;
  error: string | null;
  output: Record<string, unknown> | string | null;
  screenshot: string | null;
};

export class PostgresStore {
  private constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig
  ) {}

  static async create(config: AppConfig): Promise<PostgresStore> {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL nao configurado.");
    }

    const store = new PostgresStore(
      new Pool({
        connectionString: config.databaseUrl
      }),
      config
    );
    await store.migrate();
    await store.seed();
    return store;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getDashboardState(): Promise<DashboardState> {
    const [profiles, devices, wolGateways, commands] = await Promise.all([
      this.listSafeProfiles(),
      this.listSafeDevices(),
      this.listSafeWolGateways(),
      this.listRecentCommands()
    ]);

    return {
      profiles,
      devices,
      wolGateways,
      commands
    };
  }

  async listSafeProfiles(): Promise<SafeSiteProfile[]> {
    const result = await this.pool.query<ProfileRow>(
      "SELECT * FROM site_profiles ORDER BY name ASC"
    );
    return result.rows.map((row) => toSafeProfile(this.profileFromRow(row, false)));
  }

  async listSafeDevices(): Promise<SafeDevice[]> {
    const result = await this.pool.query<DeviceRow>(`
      SELECT
        d.*,
        COALESCE(array_agg(dp.profile_id ORDER BY dp.profile_id) FILTER (WHERE dp.profile_id IS NOT NULL), '{}') AS profile_ids
      FROM devices d
      LEFT JOIN device_profiles dp ON dp.device_id = d.id
      GROUP BY d.id
      ORDER BY d.name ASC
    `);
    return result.rows.map((row) => toSafeDevice(this.deviceFromRow(row)));
  }

  async listSafeWolGateways(): Promise<SafeWolGateway[]> {
    const result = await this.pool.query<WolGatewayRow>(
      "SELECT * FROM wol_gateways ORDER BY name ASC"
    );
    return result.rows.map((row) => toSafeWolGateway(this.wolGatewayFromRow(row)));
  }

  async listRecentCommands(): Promise<CommandRecord[]> {
    const result = await this.pool.query<CommandRow>(
      "SELECT * FROM commands ORDER BY created_at DESC LIMIT 30"
    );
    return result.rows.map((row) => this.commandFromRow(row));
  }

  async createProfile(input: {
    id?: string;
    name: string;
    siteUrl: string;
    username: string;
    password: string;
  }): Promise<SafeSiteProfile> {
    const id = await this.uniqueId(input.id ?? input.name, "site_profiles");
    const profile: SiteProfile = {
      id,
      name: input.name.trim(),
      siteUrl: input.siteUrl.trim(),
      username: input.username.trim(),
      password: input.password
    };

    await this.pool.query(
      `
        INSERT INTO site_profiles (id, name, site_url, username_cipher, password_cipher)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        profile.id,
        profile.name,
        profile.siteUrl,
        encryptSecret(profile.username, this.config.encryptionKey),
        encryptSecret(profile.password, this.config.encryptionKey)
      ]
    );

    return toSafeProfile(profile);
  }

  async createDevice(input: {
    id?: string;
    name: string;
    location: string;
    profileIds: string[];
  }): Promise<SafeDevice & { token: string }> {
    const id = await this.uniqueId(input.id ?? input.name, "devices");
    const token = randomUUID();
    const allowedProfileIds = await this.filterExistingProfileIds(input.profileIds);
    const profileIds =
      allowedProfileIds.length > 0 ? allowedProfileIds : await this.listAllProfileIds();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO devices (id, name, location, token_hash, status, wol_gateway_id)
          VALUES ($1, $2, $3, $4, 'offline', NULL)
        `,
        [
          id,
          input.name.trim(),
          input.location.trim(),
          hashToken(token, this.config.encryptionKey)
        ]
      );

      for (const profileId of profileIds) {
        await client.query(
          `
            INSERT INTO device_profiles (device_id, profile_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
          `,
          [id, profileId]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const device = await this.getDevice(id);
    if (!device) {
      throw new Error("Computador criado, mas nao encontrado.");
    }

    return {
      ...toSafeDevice(device),
      token
    };
  }

  async createWolGateway(input: {
    id?: string;
    name: string;
    location: string;
  }): Promise<SafeWolGateway & { token: string }> {
    const id = await this.uniqueId(input.id ?? input.name, "wol_gateways");
    const token = randomUUID();

    await this.pool.query(
      `
        INSERT INTO wol_gateways (id, name, location, token_hash, status)
        VALUES ($1, $2, $3, $4, 'offline')
      `,
      [
        id,
        input.name.trim(),
        input.location.trim(),
        hashToken(token, this.config.encryptionKey)
      ]
    );

    const gateway = await this.getWolGateway(id);
    if (!gateway) {
      throw new Error("Gateway WOL criado, mas nao encontrado.");
    }

    return {
      ...toSafeWolGateway(gateway),
      token
    };
  }

  async getProfile(profileId: string): Promise<SiteProfile | null> {
    const result = await this.pool.query<ProfileRow>(
      "SELECT * FROM site_profiles WHERE id = $1",
      [profileId]
    );
    return result.rows[0] ? this.profileFromRow(result.rows[0], true) : null;
  }

  async getDevice(deviceId: string): Promise<Device | null> {
    const result = await this.pool.query<DeviceRow>(
      `
        SELECT
          d.*,
          COALESCE(array_agg(dp.profile_id ORDER BY dp.profile_id) FILTER (WHERE dp.profile_id IS NOT NULL), '{}') AS profile_ids
        FROM devices d
        LEFT JOIN device_profiles dp ON dp.device_id = d.id
        WHERE d.id = $1
        GROUP BY d.id
      `,
      [deviceId]
    );
    return result.rows[0] ? this.deviceFromRow(result.rows[0]) : null;
  }

  async getSafeDevice(deviceId: string): Promise<SafeDevice | null> {
    const device = await this.getDevice(deviceId);
    return device ? toSafeDevice(device) : null;
  }

  async getWolGateway(gatewayId: string): Promise<WolGateway | null> {
    const result = await this.pool.query<WolGatewayRow>(
      "SELECT * FROM wol_gateways WHERE id = $1",
      [gatewayId]
    );
    return result.rows[0] ? this.wolGatewayFromRow(result.rows[0]) : null;
  }

  async verifyDeviceToken(deviceId: string, token: string): Promise<boolean> {
    const result = await this.pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM devices WHERE id = $1",
      [deviceId]
    );
    const tokenHash = result.rows[0]?.token_hash;
    return Boolean(tokenHash && safeEqual(tokenHash, hashToken(token, this.config.encryptionKey)));
  }

  async verifyWolGatewayToken(gatewayId: string, token: string): Promise<boolean> {
    const result = await this.pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM wol_gateways WHERE id = $1",
      [gatewayId]
    );
    const tokenHash = result.rows[0]?.token_hash;
    return Boolean(tokenHash && safeEqual(tokenHash, hashToken(token, this.config.encryptionKey)));
  }

  async markDeviceOnline(deviceId: string): Promise<Device | null> {
    await this.pool.query(
      `
        UPDATE devices
        SET status = 'online', last_seen_at = NOW()
        WHERE id = $1
      `,
      [deviceId]
    );
    return this.getDevice(deviceId);
  }

  async markDeviceOffline(deviceId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE devices
        SET status = 'offline', last_seen_at = NOW()
        WHERE id = $1
      `,
      [deviceId]
    );
  }

  async markWolGatewayOnline(gatewayId: string): Promise<WolGateway | null> {
    await this.pool.query(
      `
        UPDATE wol_gateways
        SET status = 'online', last_seen_at = NOW()
        WHERE id = $1
      `,
      [gatewayId]
    );
    return this.getWolGateway(gatewayId);
  }

  async updateDeviceState(
    deviceId: string,
    state: Partial<Pick<Device, "currentProfileId" | "activeUrl" | "title">>
  ): Promise<void> {
    const updates = ["last_seen_at = NOW()"];
    const values: unknown[] = [];

    if ("currentProfileId" in state) {
      values.push(state.currentProfileId);
      updates.push(`current_profile_id = $${values.length}`);
    }
    if ("activeUrl" in state) {
      values.push(state.activeUrl);
      updates.push(`active_url = $${values.length}`);
    }
    if ("title" in state) {
      values.push(state.title);
      updates.push(`title = $${values.length}`);
    }

    values.push(deviceId);
    await this.pool.query(
      `
        UPDATE devices
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
      `,
      values
    );
  }

  async assertDeviceCanUseProfile(deviceId: string, profileId: string): Promise<string | null> {
    const [device, profile] = await Promise.all([
      this.getDevice(deviceId),
      this.getProfile(profileId)
    ]);
    if (!device) {
      return "Computador nao encontrado.";
    }
    if (!profile) {
      return "Perfil de acesso nao encontrado.";
    }
    if (!device.profileIds.includes(profileId)) {
      return "Este computador nao esta vinculado ao perfil selecionado.";
    }
    return null;
  }

  async listDevicesUsingProfile(profileId: string, exceptDeviceId: string): Promise<SafeDevice[]> {
    const result = await this.pool.query<DeviceRow>(
      `
        SELECT
          d.*,
          COALESCE(array_agg(dp.profile_id ORDER BY dp.profile_id) FILTER (WHERE dp.profile_id IS NOT NULL), '{}') AS profile_ids
        FROM devices d
        LEFT JOIN device_profiles dp ON dp.device_id = d.id
        WHERE d.id <> $1
          AND d.status = 'online'
          AND d.current_profile_id = $2
        GROUP BY d.id
        ORDER BY d.name ASC
      `,
      [exceptDeviceId, profileId]
    );
    return result.rows.map((row) => toSafeDevice(this.deviceFromRow(row)));
  }

  async createCommand(input: {
    action: CommandAction;
    profileId: string;
    deviceId: string;
    requestedBy: string;
    payload?: CommandPayload;
  }): Promise<CommandRecord> {
    const now = new Date();
    const command: CommandRecord = {
      id: randomUUID(),
      action: input.action,
      profileId: input.profileId,
      deviceId: input.deviceId,
      requestedBy: input.requestedBy,
      payload: input.payload ?? {},
      status: "queued",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      error: null,
      output: null,
      screenshot: null
    };

    await this.pool.query(
      `
        INSERT INTO commands (
          id, action, profile_id, device_id, requested_by, payload,
          status, created_at, updated_at, error, output, screenshot
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12)
      `,
      [
        command.id,
        command.action,
        command.profileId,
        command.deviceId,
        command.requestedBy,
        JSON.stringify(command.payload),
        command.status,
        now,
        now,
        command.error,
        command.output ? JSON.stringify(command.output) : null,
        command.screenshot
      ]
    );

    return command;
  }

  async markCommandSent(commandId: string): Promise<void> {
    await this.patchCommand(commandId, {
      status: "sent"
    });
  }

  async completeCommand(
    commandId: string,
    result: {
      status: "succeeded" | "failed" | "waiting_confirmation";
      output?: Record<string, unknown>;
      error?: string;
      screenshot?: string;
    }
  ): Promise<void> {
    await this.patchCommand(commandId, {
      status: result.status,
      output: result.output ?? null,
      error: result.error ?? null,
      screenshot: result.screenshot ?? null
    });
  }

  async updateDeviceWol(
    deviceId: string,
    update: {
      macAddress: string | null;
      broadcastAddress: string | null;
      wolGatewayId: string | null;
    }
  ): Promise<Device | null> {
    await this.pool.query(
      `
        UPDATE devices
        SET
          mac_address = $2,
          broadcast_address = $3,
          wol_gateway_id = $4,
          updated_at = NOW()
        WHERE id = $1
      `,
      [deviceId, update.macAddress, update.broadcastAddress, update.wolGatewayId]
    );
    return this.getDevice(deviceId);
  }

  async updateDeviceProfiles(deviceId: string, profileIds: string[]): Promise<Device | null> {
    const exists = await this.pool.query("SELECT 1 FROM devices WHERE id = $1", [deviceId]);
    if ((exists.rowCount ?? 0) === 0) {
      return null;
    }

    const allowed = await this.filterExistingProfileIds(profileIds);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM device_profiles WHERE device_id = $1", [deviceId]);
      for (const profileId of allowed) {
        await client.query(
          `
            INSERT INTO device_profiles (device_id, profile_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
          `,
          [deviceId, profileId]
        );
      }
      await client.query(
        "UPDATE devices SET updated_at = NOW() WHERE id = $1",
        [deviceId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getDevice(deviceId);
  }

  async reserveWolCommand(gatewayId: string): Promise<WolGatewayCommand | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<
        CommandRow & {
          device_name: string;
          mac_address: string | null;
          broadcast_address: string | null;
        }
      >(
        `
          SELECT c.*, d.name AS device_name, d.mac_address, d.broadcast_address
          FROM commands c
          INNER JOIN devices d ON d.id = c.device_id
          WHERE c.action = 'power_on'
            AND c.status = 'queued'
            AND d.wol_gateway_id = $1
            AND d.mac_address IS NOT NULL
          ORDER BY c.created_at ASC
          LIMIT 1
          FOR UPDATE OF c SKIP LOCKED
        `,
        [gatewayId]
      );

      const row = result.rows[0];
      if (!row || !row.mac_address) {
        await client.query("COMMIT");
        return null;
      }

      await client.query(
        "UPDATE commands SET status = 'sent', updated_at = NOW() WHERE id = $1",
        [row.id]
      );
      await client.query("COMMIT");

      return {
        id: row.id,
        deviceId: row.device_id,
        deviceName: row.device_name,
        macAddress: row.mac_address,
        broadcastAddress: row.broadcast_address
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeWolCommand(
    gatewayId: string,
    commandId: string,
    result: {
      status: "succeeded" | "failed";
      output?: Record<string, unknown>;
      error?: string;
    }
  ): Promise<boolean> {
    const update = await this.pool.query(
      `
        UPDATE commands c
        SET
          status = $3,
          output = $4::jsonb,
          error = $5,
          updated_at = NOW()
        FROM devices d
        WHERE c.id = $1
          AND c.device_id = d.id
          AND c.action = 'power_on'
          AND d.wol_gateway_id = $2
      `,
      [
        commandId,
        gatewayId,
        result.status,
        result.output ? JSON.stringify(result.output) : null,
        result.error ?? null
      ]
    );
    return (update.rowCount ?? 0) > 0;
  }

  async resolveWaitingCommands(deviceId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE commands
        SET status = 'succeeded', updated_at = NOW()
        WHERE device_id = $1 AND status = 'waiting_confirmation'
      `,
      [deviceId]
    );
  }

  private async patchCommand(
    commandId: string,
    patch: Partial<Pick<CommandRecord, "status" | "output" | "error" | "screenshot">>
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE commands
        SET
          status = COALESCE($2, status),
          output = $3::jsonb,
          error = $4,
          screenshot = $5,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        commandId,
        patch.status ?? null,
        patch.output ? JSON.stringify(patch.output) : null,
        patch.error ?? null,
        patch.screenshot ?? null
      ]
    );
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS site_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        site_url TEXT NOT NULL,
        username_cipher TEXT NOT NULL,
        password_cipher TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wol_gateways (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TIMESTAMPTZ,
        current_profile_id TEXT REFERENCES site_profiles(id) ON DELETE SET NULL,
        active_url TEXT,
        title TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS device_profiles (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES site_profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (device_id, profile_id)
      );

      CREATE TABLE IF NOT EXISTS commands (
        id UUID PRIMARY KEY,
        action TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES site_profiles(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        requested_by TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        error TEXT,
        output JSONB,
        screenshot TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
      CREATE INDEX IF NOT EXISTS idx_devices_current_profile ON devices(current_profile_id);
      CREATE INDEX IF NOT EXISTS idx_commands_created_at ON commands(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id);

      ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac_address TEXT;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS broadcast_address TEXT;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS wol_gateway_id TEXT REFERENCES wol_gateways(id) ON DELETE SET NULL;
    `);

    await this.pool.query(
      "UPDATE devices SET status = 'offline', current_profile_id = NULL, active_url = NULL, title = NULL"
    );
  }

  private async seed(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const profile of this.config.profiles) {
        await client.query(
          `
            INSERT INTO site_profiles (id, name, site_url, username_cipher, password_cipher)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            profile.id,
            profile.name,
            profile.siteUrl,
            encryptSecret(profile.username, this.config.encryptionKey),
            encryptSecret(profile.password, this.config.encryptionKey)
          ]
        );
      }

      for (const gateway of this.config.wolGateways) {
        await client.query(
          `
            INSERT INTO wol_gateways (id, name, location, token_hash, status)
            VALUES ($1, $2, $3, $4, 'offline')
            ON CONFLICT (id) DO NOTHING
          `,
          [
            gateway.id,
            gateway.name,
            gateway.location,
            hashToken(gateway.token, this.config.encryptionKey)
          ]
        );
      }

      for (const device of this.config.devices) {
        await client.query(
          `
            INSERT INTO devices (id, name, location, token_hash, status, wol_gateway_id)
            VALUES ($1, $2, $3, $4, 'offline', $5)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            device.id,
            device.name,
            device.location,
            hashToken(device.token, this.config.encryptionKey),
            device.wolGatewayId ?? null
          ]
        );

        if (device.wolGatewayId) {
          await client.query(
            `
              UPDATE devices
              SET wol_gateway_id = COALESCE(wol_gateway_id, $2)
              WHERE id = $1
            `,
            [device.id, device.wolGatewayId]
          );
        }

        for (const profileId of device.profileIds) {
          await client.query(
            `
              INSERT INTO device_profiles (device_id, profile_id)
              VALUES ($1, $2)
              ON CONFLICT DO NOTHING
            `,
            [device.id, profileId]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private profileFromRow(row: ProfileRow, includePassword: boolean): SiteProfile {
    return {
      id: row.id,
      name: row.name,
      siteUrl: row.site_url,
      username: decryptSecret(row.username_cipher, this.config.encryptionKey),
      password: includePassword
        ? decryptSecret(row.password_cipher, this.config.encryptionKey)
        : ""
    };
  }

  private deviceFromRow(row: DeviceRow): Device {
    return {
      id: row.id,
      name: row.name,
      location: row.location,
      token: "",
      profileIds: row.profile_ids ?? [],
      status: row.status === "online" ? "online" : "offline",
      lastSeenAt: this.toIso(row.last_seen_at),
      currentProfileId: row.current_profile_id,
      activeUrl: row.active_url,
      title: row.title,
      macAddress: row.mac_address,
      broadcastAddress: row.broadcast_address,
      wolGatewayId: row.wol_gateway_id
    };
  }

  private wolGatewayFromRow(row: WolGatewayRow): WolGateway {
    return {
      id: row.id,
      name: row.name,
      location: row.location,
      token: "",
      status: this.isGatewayFresh(row.last_seen_at) ? "online" : "offline",
      lastSeenAt: this.toIso(row.last_seen_at)
    };
  }

  private commandFromRow(row: CommandRow): CommandRecord {
    return {
      id: row.id,
      action: row.action,
      profileId: row.profile_id,
      deviceId: row.device_id,
      requestedBy: row.requested_by,
      payload: this.asObject(row.payload),
      status: row.status,
      createdAt: this.toIso(row.created_at) ?? new Date().toISOString(),
      updatedAt: this.toIso(row.updated_at) ?? new Date().toISOString(),
      error: row.error,
      output: row.output ? this.asObject(row.output) : null,
      screenshot: row.screenshot
    };
  }

  private asObject(value: CommandPayload | Record<string, unknown> | string): Record<string, unknown> {
    if (typeof value === "string") {
      return JSON.parse(value) as Record<string, unknown>;
    }
    return value;
  }

  private toIso(value: Date | string | null): string | null {
    if (!value) {
      return null;
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private async filterExistingProfileIds(profileIds: string[]): Promise<string[]> {
    if (profileIds.length === 0) {
      return [];
    }

    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM site_profiles WHERE id = ANY($1::text[])",
      [profileIds]
    );
    return result.rows.map((row) => row.id);
  }

  private async listAllProfileIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM site_profiles ORDER BY name ASC"
    );
    return result.rows.map((row) => row.id);
  }

  private async uniqueId(
    seed: string,
    table: "site_profiles" | "devices" | "wol_gateways"
  ): Promise<string> {
    const base =
      seed
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || randomUUID();

    let candidate = base;
    let index = 2;
    while (await this.idExists(table, candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    return candidate;
  }

  private async idExists(
    table: "site_profiles" | "devices" | "wol_gateways",
    id: string
  ): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private isGatewayFresh(lastSeenAt: Date | string | null): boolean {
    if (!lastSeenAt) {
      return false;
    }
    return Date.now() - new Date(lastSeenAt).getTime() <= WOL_GATEWAY_FRESH_MS;
  }
}
