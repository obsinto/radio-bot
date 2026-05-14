# Plano do Agente Local

## Objetivo

O agente local e o programa que roda em cada computador da radio. Ele conecta esse computador a VPS/API e executa, localmente, os comandos enviados pelo painel web.

Esse agente substitui a necessidade de AnyDesk para tarefas especificas do site: em vez de abrir a tela inteira da maquina, o operador usa o painel e envia comandos autorizados para o computador escolhido.

## O Que Ja Existe

Ja existe um esboco funcional em `apps/agent`.

Arquivos principais:

- `apps/agent/src/index.ts`: ponto de entrada do agente.
- `apps/agent/src/config.ts`: leitura das variaveis de ambiente.
- `apps/agent/src/client.ts`: conexao WebSocket com a API, heartbeat e recebimento de comandos.
- `apps/agent/src/browser-controller.ts`: controle do navegador local via Playwright/Chromium.
- `apps/agent/radio-bot-agent.service.example`: exemplo de servico Linux com `systemd`.

## Como Funciona Hoje

1. O agente inicia no computador local.
2. Ele le as configuracoes do ambiente:
   - `SERVER_URL`
   - `DEVICE_ID`
   - `DEVICE_TOKEN`
   - `BROWSER_PROFILE_PATH`
   - `HEADLESS`
   - `ACTION_MAP_JSON`
3. Ele conecta na API por WebSocket.
4. A API valida `DEVICE_ID` e `DEVICE_TOKEN`.
5. Se estiver autorizado, o painel mostra esse computador como online.
6. O agente envia heartbeat periodico para manter o status atualizado.
7. Quando o usuario envia um comando no painel, a API repassa o comando ao agente correto.
8. O agente executa o comando no navegador local usando Playwright.
9. O agente devolve status, erro, estado atual ou screenshot para a API.
10. O painel mostra o resultado no historico.

## Comandos Ja Implementados

- `open_site`: abre a URL do perfil de radio.
- `login`: tenta preencher usuario e senha automaticamente.
- `reload`: recarrega a pagina atual.
- `screenshot`: captura uma imagem do navegador local.
- `get_state`: retorna URL atual, titulo da pagina e perfil ativo.
- `click_action`: executa um clique em seletor previamente mapeado no `ACTION_MAP_JSON`.

## Configuracao Atual do Agente

Exemplo local:

```bash
SERVER_URL=ws://localhost:3000/agent
DEVICE_ID=studio-01
DEVICE_TOKEN=change-studio-01-token
BROWSER_PROFILE_PATH=.cache/browser/studio-01
HEADLESS=false
ACTION_MAP_JSON={}
```

Exemplo em producao:

```bash
SERVER_URL=wss://api.seu-dominio.com/agent
DEVICE_ID=studio-01
DEVICE_TOKEN=token-gerado-no-painel
BROWSER_PROFILE_PATH=C:\RadioBOT\browser-profile
HEADLESS=false
ACTION_MAP_JSON={}
```

Cada computador precisa ter `DEVICE_ID` e `DEVICE_TOKEN` proprios. O mesmo software roda em todos os computadores, mas a configuracao identifica cada maquina individualmente.

## O Que Falta Para Uso Real

### 1. Instalador para Windows

Prioridade alta se os computadores das radios forem PCs Windows.

Status: existe um instalador MVP em `scripts/windows/install-agent.ps1`, com documentacao em `docs/WINDOWS_AGENT_INSTALL.md`.

O instalador usa Tarefa Agendada no logon do usuario, nao servico Windows, porque o Chromium precisa aparecer na tela do operador local.

Ja implementado:

- Criar pasta padrao, por exemplo `C:\RadioBOT`.
- Instalar dependencias do agente.
- Gerar `.env` com `SERVER_URL`, `DEVICE_ID` e `DEVICE_TOKEN`.
- Instalar Chromium/Playwright.
- Registrar o agente como Tarefa Agendada no logon.
- Iniciar automaticamente quando o usuario entrar no Windows.
- Reiniciar automaticamente em caso de falha.
- Salvar logs locais.

Itens pendentes:

- Testar o script em uma maquina Windows real.
- Melhorar atualizacao/reinstalacao quando houver nova versao.
- Criar pacote zip/release para entrega mais simples.

### 2. Instalador para Linux

Ja existe um exemplo inicial com `systemd`, mas ainda falta transformar em instalacao completa.

Itens pendentes:

- Criar usuario de sistema para o agente.
- Criar pasta padrao, por exemplo `/opt/radio-bot`.
- Copiar build do agente.
- Criar `.env`.
- Instalar dependencias e browsers do Playwright.
- Instalar arquivo `.service`.
- Habilitar start automatico no boot.
- Configurar logs via `journalctl` ou arquivo local.

### 3. Empacotamento

Hoje o agente roda como projeto Node.js. Para operacao real, precisamos decidir o formato de entrega:

- Manter Node.js instalado na maquina local.
- Empacotar como executavel.
- Entregar uma pasta pronta com script de instalacao.

Opcao recomendada para MVP: pasta pronta + script de instalacao. Depois, empacotar como executavel quando o comportamento do site estiver estabilizado.

### 4. Mapeamento Real do Site

O login automatico atual usa seletores genericos. Para ficar confiavel, precisamos analisar o HTML real do site e mapear seletores especificos.

Itens pendentes:

- Validar URL correta do site.
- Abrir o site com Playwright.
- Identificar campos reais de login.
- Identificar botoes e controles usados pela radio.
- Criar `ACTION_MAP_JSON` com chaves claras.
- Testar cada comando com screenshot.

Exemplo futuro:

```json
{
  "play": "button[data-action='play']",
  "stop": "button[data-action='stop']",
  "refresh-player": "#refresh-player"
}
```

### 5. Atualizacao Remota do Agente

Ainda nao existe mecanismo de atualizacao.

Opcoes:

- Atualizacao manual por script.
- Agente baixa nova versao da VPS.
- Instalador roda novamente por cima.

Para MVP, atualizacao manual por script e suficiente.

### 6. Observabilidade Local

Ainda falta melhorar diagnostico na maquina local.

Itens pendentes:

- Arquivo de log local.
- Identificacao da versao do agente.
- Comando de diagnostico.
- Registro de ultimo erro de Playwright.
- Status de navegador aberto/fechado.
- Tamanho do perfil persistente do navegador.

### 7. Seguranca Local

Itens pendentes:

- Proteger `.env` com permissao adequada.
- Evitar logs com senhas.
- Nao aceitar comandos arbitrarios.
- Nao permitir execucao de shell remoto.
- Permitir somente acoes predefinidas.
- Rotacionar `DEVICE_TOKEN` quando necessario.

## Criterios de Aceite do Agente

- Agente instala em um computador local.
- Agente inicia automaticamente com o sistema.
- Agente reconecta sozinho se a internet cair.
- Painel mostra o computador como online/offline corretamente.
- Agente abre o site no navegador local.
- Agente tenta login com perfil escolhido no painel.
- Agente envia screenshot sob demanda.
- Agente executa acoes mapeadas no site.
- Agente mantem sessao do navegador usando perfil persistente.
- Logs permitem diagnosticar erro de conexao, erro de login e erro de seletor.

## Proxima Fase Recomendada

1. Confirmar o sistema operacional dos computadores das radios.
2. Criar primeiro instalador para o sistema operacional mais comum.
3. Validar o acesso real ao site em uma maquina local.
4. Mapear seletores reais do site.
5. Transformar os comandos genericos em comandos especificos da operacao da radio.
