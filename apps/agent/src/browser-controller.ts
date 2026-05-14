import { chromium, type BrowserContext, type Page } from "playwright";
import type { AgentBrowserState, AgentCommand, SiteProfile, SitePrompt } from "@radio-bot/shared";
import type { AgentConfig } from "./config.js";

type CommandExecutionResult = {
  output?: Record<string, unknown>;
  screenshot?: string;
  status?: "succeeded" | "waiting_confirmation";
  state: Partial<AgentBrowserState>;
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

  private async login(profile: SiteProfile): Promise<void> {
    const page = await this.ensurePage(profile);
    if (!page.url() || page.url() === "about:blank") {
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

  private async clickFirst(page: Page, selectors: string[]): Promise<boolean> {
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
