import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright";
import type { AgentBrowserState, AgentCommand, SiteProfile, SitePrompt } from "@radio-bot/shared";
import type { AgentConfig } from "./config.js";

const execFileAsync = promisify(execFile);

type CommandExecutionResult = {
  output?: Record<string, unknown>;
  screenshot?: string;
  status?: "succeeded" | "waiting_confirmation";
  state: Partial<AgentBrowserState>;
};

type LocatorScope = Pick<Page, "locator">;

type MediaState = {
  found: number;
  playing: number;
  paused: number;
  attempted?: number;
  errors?: number;
};

export class BrowserController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentProfileId: string | null = null;

  constructor(private readonly config: AgentConfig) {}

  async execute(command: AgentCommand, profile: SiteProfile): Promise<CommandExecutionResult> {
    if (command.action === "open_site") {
      await this.openSite(profile);
      const sitePrompt = await this.detectSitePrompt();
      if (sitePrompt) {
        return {
          status: "waiting_confirmation",
          output: {
            sitePrompt
          },
          state: await this.getState()
        };
      }
      return {
        output: {
          opened: true
        },
        state: await this.getState()
      };
    }

    if (command.action === "login") {
      await this.login(profile);
      const sitePrompt = await this.detectSitePrompt();
      if (sitePrompt) {
        return {
          status: "waiting_confirmation",
          output: {
            sitePrompt
          },
          state: await this.getState()
        };
      }
      return {
        output: {
          loggedInAttempted: true
        },
        state: await this.getState()
      };
    }

    if (command.action === "reload") {
      const page = await this.ensurePage(profile);
      await page.reload({
        waitUntil: "domcontentloaded"
      });
      return {
        output: {
          reloaded: true
        },
        state: await this.getState()
      };
    }

    if (command.action === "screenshot") {
      const page = await this.ensurePage(profile);
      const image = await page.screenshot({
        type: "jpeg",
        quality: 70,
        fullPage: false
      });
      return {
        screenshot: `data:image/jpeg;base64,${image.toString("base64")}`,
        output: {
          captured: true
        },
        state: await this.getState()
      };
    }

    if (command.action === "get_state") {
      return {
        output: await this.getState(),
        state: await this.getState()
      };
    }

    if (command.action === "click_action") {
      const actionKey = command.payload.actionKey;
      if (typeof actionKey !== "string" || !this.config.actionMap[actionKey]) {
        throw new Error("Acao nao mapeada no agente local.");
      }

      const page = await this.ensurePage(profile);
      await page.locator(this.config.actionMap[actionKey]).first().click({
        timeout: 5000
      });
      return {
        output: {
          clicked: actionKey
        },
        state: await this.getState()
      };
    }

    if (command.action === "play_radio") {
      return {
        output: await this.playRadio(profile),
        state: await this.getState()
      };
    }

    if (command.action === "stop_playback") {
      return {
        output: await this.stopPlayback(profile, command.payload),
        state: await this.getState()
      };
    }

    if (command.action === "shutdown") {
      return {
        output: await this.shutdownComputer(command.payload),
        state: await this.getState()
      };
    }

    if (command.action === "confirm_open_here") {
      const page = await this.ensurePage(profile);
      await this.clickOpenHere(page);
      await page.waitForLoadState("domcontentloaded", {
        timeout: 15000
      }).catch(() => undefined);
      await page.waitForTimeout(1000);
      return {
        output: {
          confirmedOpenHere: true
        },
        state: await this.getState()
      };
    }

    throw new Error(`Comando nao suportado: ${command.action}`);
  }

  async getState(): Promise<AgentBrowserState> {
    if (this.page?.isClosed()) {
      this.page = null;
    }

    return {
      currentProfileId: this.currentProfileId,
      activeUrl: this.page?.url() ?? null,
      title: this.page ? await this.safeTitle(this.page) : null
    };
  }

  private async ensurePage(profile: SiteProfile): Promise<Page> {
    if (this.page?.isClosed()) {
      this.page = null;
    }

    if (this.context) {
      try {
        this.page = this.page ?? this.context.pages().find((page) => !page.isClosed()) ?? null;
        this.page = this.page ?? (await this.context.newPage());
      } catch (error) {
        if (!this.isClosedBrowserError(error)) {
          throw error;
        }
        await this.resetBrowser();
      }
    }

    if (!this.context) {
      await this.launchBrowser();
    }

    if (!this.context) {
      throw new Error("Nao foi possivel iniciar o navegador local.");
    }

    this.page = this.page ?? this.context.pages().find((page) => !page.isClosed()) ?? null;
    this.page = this.page ?? (await this.context.newPage());
    this.currentProfileId = profile.id;
    return this.page;
  }

  private async launchBrowser(): Promise<void> {
    this.context = await chromium.launchPersistentContext(this.config.browserProfilePath, {
      headless: this.config.headless,
      viewport: {
        width: 1280,
        height: 800
      }
    });

    this.context.on("close", () => {
      this.context = null;
      this.page = null;
    });
  }

  private async resetBrowser(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    await context?.close().catch(() => undefined);
  }

  private isClosedBrowserError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /has been closed|Target page, context or browser has been closed/i.test(message);
  }

  private async openSite(profile: SiteProfile): Promise<void> {
    const page = await this.ensurePage(profile);
    await page.goto(profile.siteUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForTimeout(1000);
  }

  private async detectSitePrompt(timeoutMs = 10000): Promise<SitePrompt | null> {
    if (!this.page || this.page.isClosed()) {
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.page || this.page.isClosed()) {
        return null;
      }

      const openHereVisible = await this.page
        .getByText(/abrir nesta janela/i)
        .first()
        .isVisible()
        .catch(() => false);

      if (openHereVisible) {
        return {
          type: "open_here",
          title: "Sistema em uso",
          message:
            "A radio ja esta aberta em outra janela ou equipamento. Deseja abrir nesta janela e assumir o controle aqui?",
          confirmLabel: "Abrir nesta janela",
          cancelLabel: "Manter como esta"
        };
      }

      await this.page.waitForTimeout(500).catch(() => undefined);
    }

    return null;
  }

  private async clickOpenHere(page: Page): Promise<void> {
    const clicked = await this.clickFirst(page, [
      'button:has-text("Abrir nesta janela")',
      'a:has-text("Abrir nesta janela")',
      'div:has-text("Abrir nesta janela")',
      'span:has-text("Abrir nesta janela")'
    ]);

    if (!clicked) {
      throw new Error("Nao foi possivel encontrar o botao 'Abrir nesta janela'.");
    }
  }

  private async playRadio(profile: SiteProfile): Promise<Record<string, unknown>> {
    let page = await this.ensurePage(profile);
    if (this.shouldOpenProfileUrl(page.url(), profile.siteUrl)) {
      await this.openSite(profile);
      page = await this.ensurePage(profile);
    }

    const selectors = this.actionSelectors(profile, "play", [
      'button[aria-label*="play" i]',
      '[role="button"][aria-label*="play" i]',
      '[title*="play" i]',
      'button:has-text("Play")',
      'a:has-text("Play")',
      'button:has-text("Ouvir")',
      'a:has-text("Ouvir")',
      '[role="button"]:has-text("Ouvir")',
      'button:has-text("Ao vivo")',
      'a:has-text("Ao vivo")',
      ".btn-play",
      ".play"
    ]);

    const clicked = await this.clickFirstInFrames(page, selectors);
    if (clicked.clicked) {
      await page.waitForTimeout(1000);
    }

    const media = await this.playMediaElements(page);
    return {
      action: "play_radio",
      clicked,
      media,
      activeUrl: page.url()
    };
  }

  private async stopPlayback(
    profile: SiteProfile,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const page = this.page && !this.page.isClosed() ? this.page : null;
    if (!page) {
      return {
        action: "stop_playback",
        stopped: false,
        reason: "Nenhuma pagina ativa para parar."
      };
    }

    const selectors = this.actionSelectors(profile, "stop", [
      'button[aria-label*="pause" i]',
      '[role="button"][aria-label*="pause" i]',
      '[title*="pause" i]',
      'button[aria-label*="stop" i]',
      '[role="button"][aria-label*="stop" i]',
      '[title*="stop" i]',
      'button:has-text("Pause")',
      'button:has-text("Pausar")',
      'button:has-text("Stop")',
      'button:has-text("Parar")',
      ".btn-pause",
      ".pause",
      ".btn-stop",
      ".stop"
    ]);

    const clicked = await this.clickFirstInFrames(page, selectors);
    if (clicked.clicked) {
      await page.waitForTimeout(500);
    }

    const media = await this.pauseMediaElements(page);
    const closePage = payload.closePage === true;
    if (closePage) {
      await page.close().catch(() => undefined);
      this.page = null;
      this.currentProfileId = null;
    }

    return {
      action: "stop_playback",
      clicked,
      media,
      closedPage: closePage,
      activeUrl: closePage ? null : page.url()
    };
  }

  private async shutdownComputer(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestedDelaySeconds = this.clampNumber(payload.delaySeconds, 60, 0, 3600);
    const force = payload.force === true;
    const shutdown = this.buildShutdownCommand(requestedDelaySeconds, force);
    if (this.config.shutdownDryRun) {
      return {
        action: "shutdown",
        scheduled: true,
        dryRun: true,
        platform: platform(),
        command: shutdown.file,
        args: shutdown.args,
        requestedDelaySeconds,
        effectiveDelaySeconds: shutdown.effectiveDelaySeconds,
        force,
        stdout: "",
        stderr: ""
      };
    }

    const result = await execFileAsync(shutdown.file, shutdown.args, {
      timeout: 5000
    });

    return {
      action: "shutdown",
      scheduled: true,
      dryRun: false,
      platform: platform(),
      command: shutdown.file,
      args: shutdown.args,
      requestedDelaySeconds,
      effectiveDelaySeconds: shutdown.effectiveDelaySeconds,
      force,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    };
  }

  private shouldOpenProfileUrl(currentUrl: string, targetUrl: string): boolean {
    if (!currentUrl || currentUrl === "about:blank") {
      return true;
    }

    try {
      const current = new URL(currentUrl);
      const target = new URL(targetUrl);
      current.hash = "";
      target.hash = "";
      return current.toString() !== target.toString();
    } catch {
      return true;
    }
  }

  private actionSelectors(profile: SiteProfile, action: "play" | "stop", fallback: string[]): string[] {
    return [
      this.config.actionMap[`${profile.id}.${action}`],
      this.config.actionMap[`${profile.id}_${action}`],
      this.config.actionMap[action],
      ...fallback
    ].filter((selector): selector is string => Boolean(selector));
  }

  private async clickFirstInFrames(
    page: Page,
    selectors: string[]
  ): Promise<{ clicked: boolean; selector: string | null; frameUrl: string | null }> {
    for (const frame of page.frames()) {
      const selector = await this.clickFirstSelector(frame, selectors);
      if (selector) {
        return {
          clicked: true,
          selector,
          frameUrl: frame.url()
        };
      }
    }

    return {
      clicked: false,
      selector: null,
      frameUrl: null
    };
  }

  private async clickFirstSelector(scope: LocatorScope, selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      try {
        if ((await locator.count()) > 0) {
          await locator.click({
            timeout: 2500
          });
          return selector;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private async playMediaElements(page: Page): Promise<MediaState> {
    return this.reduceMediaStates(
      await Promise.all(page.frames().map((frame) => this.playMediaElementsInFrame(frame)))
    );
  }

  private async pauseMediaElements(page: Page): Promise<MediaState> {
    return this.reduceMediaStates(
      await Promise.all(page.frames().map((frame) => this.pauseMediaElementsInFrame(frame)))
    );
  }

  private async playMediaElementsInFrame(frame: Frame): Promise<MediaState> {
    return frame
      .evaluate(async () => {
        const elements = Array.from(document.querySelectorAll("audio, video")) as HTMLMediaElement[];
        let attempted = 0;
        let errors = 0;

        for (const element of elements) {
          attempted += 1;
          try {
            await element.play();
          } catch {
            errors += 1;
          }
        }

        return {
          found: elements.length,
          playing: elements.filter((element) => !element.paused && !element.ended).length,
          paused: elements.filter((element) => element.paused).length,
          attempted,
          errors
        };
      })
      .catch(() => ({
        found: 0,
        playing: 0,
        paused: 0,
        attempted: 0,
        errors: 1
      }));
  }

  private async pauseMediaElementsInFrame(frame: Frame): Promise<MediaState> {
    return frame
      .evaluate(() => {
        const elements = Array.from(document.querySelectorAll("audio, video")) as HTMLMediaElement[];
        let attempted = 0;

        for (const element of elements) {
          if (!element.paused) {
            attempted += 1;
            element.pause();
          }
        }

        return {
          found: elements.length,
          playing: elements.filter((element) => !element.paused && !element.ended).length,
          paused: elements.filter((element) => element.paused).length,
          attempted,
          errors: 0
        };
      })
      .catch(() => ({
        found: 0,
        playing: 0,
        paused: 0,
        attempted: 0,
        errors: 1
      }));
  }

  private reduceMediaStates(states: MediaState[]): MediaState {
    return states.reduce<MediaState>(
      (total, state) => ({
        found: total.found + state.found,
        playing: total.playing + state.playing,
        paused: total.paused + state.paused,
        attempted: (total.attempted ?? 0) + (state.attempted ?? 0),
        errors: (total.errors ?? 0) + (state.errors ?? 0)
      }),
      {
        found: 0,
        playing: 0,
        paused: 0,
        attempted: 0,
        errors: 0
      }
    );
  }

  private buildShutdownCommand(
    delaySeconds: number,
    force: boolean
  ): { file: string; args: string[]; effectiveDelaySeconds: number } {
    if (platform() === "win32") {
      const args = ["/s", "/t", String(delaySeconds)];
      if (force) {
        args.push("/f");
      }
      return {
        file: "shutdown.exe",
        args,
        effectiveDelaySeconds: delaySeconds
      };
    }

    if (delaySeconds <= 0) {
      return {
        file: "shutdown",
        args: ["-h", "now"],
        effectiveDelaySeconds: 0
      };
    }

    const delayMinutes = Math.max(1, Math.ceil(delaySeconds / 60));
    return {
      file: "shutdown",
      args: ["-h", `+${delayMinutes}`],
      effectiveDelaySeconds: delayMinutes * 60
    };
  }

  private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(numberValue)));
  }

  private async login(profile: SiteProfile): Promise<void> {
    const page = await this.ensurePage(profile);
    if (this.shouldOpenProfileUrl(page.url(), profile.siteUrl)) {
      await this.openSite(profile);
    }

    const usernameFilled = await this.fillFirst(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[name*="user" i]',
      'input[id*="email" i]',
      'input[id*="login" i]',
      'input[id*="user" i]',
      'input[type="text"]'
    ], profile.username);

    const passwordFilled = await this.fillFirst(page, [
      'input[type="password"]',
      'input[name*="senha" i]',
      'input[name*="password" i]',
      'input[id*="senha" i]',
      'input[id*="password" i]'
    ], profile.password);

    if (!usernameFilled || !passwordFilled) {
      throw new Error("Nao foi possivel localizar campos de login automaticamente.");
    }

    const clicked = await this.clickFirst(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Acessar")',
      'a:has-text("Entrar")'
    ]);

    if (!clicked) {
      await page.keyboard.press("Enter");
    }

    await page.waitForLoadState("domcontentloaded", {
      timeout: 15000
    }).catch(() => undefined);
    await page.waitForTimeout(1000);

    const invalidCredentialsVisible = await page
      .getByText(/credenciais/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (invalidCredentialsVisible) {
      throw new Error("Login recusado pelo site: credenciais invalidas.");
    }
  }

  private async fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0) {
          await locator.fill(value, {
            timeout: 2000
          });
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  private async clickFirst(page: LocatorScope, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0) {
          await locator.click({
            timeout: 3000
          });
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  private async safeTitle(page: Page): Promise<string | null> {
    try {
      return await page.title();
    } catch {
      return null;
    }
  }
}
