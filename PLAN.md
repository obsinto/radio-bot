# Plano de Desenvolvimento - Radio BOT

## Objetivo

Criar um bot/app para automatizar o acesso e o controle do site informado em `acesso.txt`, permitindo que usuarios autorizados controlem, pelo navegador, o comportamento do site em computadores especificos, sem depender de AnyDesk ou acesso remoto de tela inteira.

O sistema deve atender pelo menos dois locais/computadores diferentes e usar a VPS com Coolify como ponto central de deploy, autenticacao, comunicacao e auditoria.

## Premissas

- O site, login e senha existem em `acesso.txt`, mas credenciais nao devem ser copiadas para codigo, documentacao publica ou frontend.
- O endereco informado em `acesso.txt` parece ter erro de protocolo (`htpp//`). Antes da automacao, validar o endereco correto, provavelmente `http://...` ou `https://...`.
- A automacao sera usada apenas em contas, maquinas e servicos autorizados pelo dono da radio/sistema.
- Como o objetivo e controlar o comportamento em computadores especificos, a VPS nao deve executar tudo sozinha. Cada computador local precisa rodar um agente local conectado a VPS.
- O painel deve suportar mais de uma radio/conta do mesmo site, pois podem existir radios diferentes ou acessos independentes usando a mesma plataforma.
- Um mesmo perfil de acesso pode ser vinculado a varios computadores, ou cada computador pode usar um perfil de acesso proprio.

## Arquitetura Proposta

### 1. Painel Web na VPS

Aplicacao acessada pelo navegador pelos usuarios autorizados.

Responsabilidades:

- Login dos operadores.
- Cadastro de radios/perfis de acesso.
- Lista de computadores/agentes online e offline.
- Tela de controle por computador.
- Associar cada computador a uma radio/perfil de acesso.
- Botoes para acoes permitidas, como abrir site, fazer login, recarregar pagina, iniciar/parar player e capturar estado.
- Historico de comandos executados.
- Logs de erro e eventos importantes.

### 2. Backend Central

Servico publicado na VPS via Coolify.

Responsabilidades:

- Autenticar usuarios.
- Receber comandos do painel web.
- Manter conexoes WebSocket com os agentes locais.
- Enviar comandos para o computador correto.
- Receber respostas, status, screenshots e logs dos agentes.
- Persistir auditoria e estado atual.
- Gerenciar cadastro e token de cada computador.

### 3. Agente Local por Computador

Programa instalado em cada computador que precisa controlar o site.

Responsabilidades:

- Conectar na VPS por WebSocket usando token proprio do dispositivo.
- Manter heartbeat constante para informar que esta online.
- Abrir/controlar um navegador local com Playwright.
- Executar somente comandos permitidos pelo backend.
- Manter sessao do navegador quando possivel.
- Enviar resultado de cada comando para o backend.
- Opcionalmente enviar screenshot do navegador para confirmacao visual.

Importante: o agente local deve iniciar a conexao para a VPS. Assim, os locais nao precisam abrir porta de entrada no roteador.

### 4. Site Alvo

O site sera controlado pelo navegador local do computador, nao diretamente pelo navegador do usuario que esta no painel.

Cada automacao deve usar um perfil de acesso configurado no backend. Esse perfil representa uma radio ou conta do site, com URL, usuario, senha e configuracoes proprias. Assim, o mesmo sistema pode operar:

- Varios computadores usando a mesma conta.
- Varios computadores usando contas diferentes do mesmo site.
- Radios diferentes, cada uma com seus proprios computadores e operadores.

Fluxo esperado:

1. Usuario acessa o painel web.
2. Usuario escolhe uma radio/perfil, quando tiver acesso a mais de uma.
3. Usuario escolhe um computador vinculado.
4. Usuario clica em uma acao.
5. Backend envia comando ao agente daquele computador com o perfil correto.
6. Agente executa a acao no navegador local.
7. Agente devolve status, erro ou screenshot.
8. Painel mostra o resultado.

## Stack Recomendada

Como o projeto envolve automacao de navegador, uma stack TypeScript simplifica o compartilhamento de tipos entre painel, backend e agente.

- Backend: Node.js + TypeScript + Fastify ou NestJS.
- Comunicacao em tempo real: WebSocket ou Socket.IO.
- Automacao local: Playwright com Chromium persistente.
- Frontend: React + Vite.
- Banco: PostgreSQL na VPS para producao, com fallback em memoria apenas para testes locais rapidos.
- Cache/fila opcional: Redis, se comandos assincronos crescerem.
- Deploy: Docker + Coolify.
- Agente local: Node.js empacotado como servico do sistema.

## Requisitos Funcionais

- Cadastro de usuarios operadores.
- Cadastro de radios/perfis de acesso.
- Cadastro de computadores/agentes.
- Vinculo entre computador e radio/perfil de acesso.
- Token unico por agente.
- Indicador online/offline por computador.
- Controle separado por computador.
- Controle separado por radio/perfil quando houver mais de uma conta.
- Aviso e confirmacao dupla quando o usuario tentar usar uma mesma conta/perfil em mais de um computador ao mesmo tempo.
- Execucao de comandos predefinidos.
- Registro de quem executou cada comando.
- Retorno de sucesso/erro por comando.
- Captura de screenshot sob demanda.
- Persistencia de sessao do site quando possivel.
- Reautenticacao automatica quando a sessao expirar.

## Comandos Iniciais do MVP

- `open_site`: abrir o endereco configurado.
- `login`: preencher credenciais armazenadas com seguranca e autenticar.
- `reload`: recarregar pagina.
- `screenshot`: capturar imagem atual do navegador.
- `get_state`: retornar URL atual, titulo da pagina e status basico.
- `click_action`: clicar em elementos mapeados previamente, nunca seletor livre enviado pelo usuario.

Depois da analise do site, adicionar comandos especificos, como play, pause, troca de fonte, troca de programa, ajuste de tela ou qualquer controle real disponivel no painel do site.

## Modelo de Dados Inicial

- `users`: operadores do painel.
- `organizations` ou `radios`: agrupamento logico por radio/cliente.
- `devices`: computadores/agentes cadastrados.
- `device_tokens`: tokens rotacionaveis dos agentes.
- `device_profiles`: vinculo entre computadores e perfis de acesso permitidos.
- `commands`: comandos solicitados pelo painel.
- `command_events`: logs de envio, execucao, sucesso e erro.
- `site_profiles`: configuracoes do site alvo por radio/conta, sem senha em texto no codigo.
- `automation_actions`: acoes mapeadas para seletores e passos do Playwright.

## Seguranca

- Remover credenciais de arquivos versionados antes de publicar o repositorio.
- Usar variaveis de ambiente ou cofre de segredos no Coolify.
- Nunca enviar senha para o frontend.
- Criptografar credenciais de cada perfil de acesso no banco, usando chave de ambiente.
- Usar HTTPS obrigatorio na VPS.
- Autenticacao forte no painel.
- Tokens unicos por computador.
- Permitir revogar token de agente.
- Registrar auditoria de comandos.
- Limitar comandos a uma lista permitida.
- Nao permitir execucao remota de shell pelo painel.
- Nao permitir JavaScript arbitrario vindo do usuario.
- Restringir screenshots a usuarios autenticados.

## Deploy com Coolify

Servicos na VPS:

- `web`: frontend do painel.
- `api`: backend HTTP/WebSocket.
- `postgres`: banco de dados.
- `redis`: opcional para fila/status, se necessario.

Variaveis esperadas:

- `APP_URL`
- `DATABASE_URL`
- `JWT_SECRET`
- `ENCRYPTION_KEY`
- `SITE_URL`
- `WS_PUBLIC_URL`

As credenciais de radios/perfis podem comecar em variaveis de ambiente no MVP, mas o ideal e evoluir para cadastro no painel com armazenamento criptografado no banco.

O agente local tera configuracao propria:

- `SERVER_URL`
- `DEVICE_ID`
- `DEVICE_TOKEN`
- `BROWSER_PROFILE_PATH`

## Instalacao do Agente Local

### Linux

- Rodar como servico `systemd`.
- Iniciar automaticamente no boot.
- Reiniciar em caso de falha.
- Manter perfil persistente do Chromium em pasta propria.

### Windows

- Rodar como servico usando NSSM, WinSW ou empacotamento equivalente.
- Iniciar automaticamente com o sistema.
- Manter logs locais.
- Manter perfil persistente do Chromium em pasta propria.

## Fases de Execucao

### Fase 0 - Levantamento

- Validar endereco correto do site.
- Identificar sistema operacional dos computadores locais.
- Definir quais acoes precisam ser controladas no site.
- Confirmar se os dois locais usam a mesma conta ou contas diferentes.
- Confirmar se ha multiplas radios/contas que precisam operar no mesmo painel.
- Verificar se o site possui captcha, 2FA, bloqueio por IP ou expiracao frequente de sessao.

### Fase 1 - Prova de Conceito Local

- Criar script Playwright que abre o site.
- Automatizar login em ambiente local.
- Capturar screenshot.
- Validar seletores principais.
- Confirmar que a sessao pode ser mantida em perfil persistente.

### Fase 2 - Backend e Comunicacao

- Criar API central.
- Criar canal WebSocket para agentes.
- Implementar cadastro de dispositivos.
- Implementar heartbeat.
- Implementar envio de comandos e retorno de resultado.

### Fase 3 - Painel Web

- Criar tela de login.
- Criar dashboard de computadores.
- Criar tela de controle por computador.
- Criar historico de comandos.
- Exibir status, erros e screenshots.

### Fase 4 - Agente Local

- Implementar conexao persistente com a VPS.
- Integrar Playwright.
- Implementar comandos do MVP.
- Adicionar reconexao automatica.
- Criar logs locais.
- Preparar instalacao como servico.

### Fase 5 - Deploy

- Criar Dockerfiles.
- Configurar Coolify.
- Configurar dominio e HTTPS.
- Configurar banco e variaveis.
- Instalar agente nos computadores locais.
- Testar controle remoto real.

### Fase 6 - Hardening

- Adicionar rotacao de tokens.
- Adicionar auditoria detalhada.
- Adicionar permissoes por usuario.
- Melhorar tratamento de erro do site.
- Adicionar alertas de agente offline.
- Adicionar backup do banco.

## Riscos e Pontos de Atencao

- Mudancas no HTML do site podem quebrar seletores do Playwright.
- Captcha ou 2FA podem impedir login totalmente automatizado.
- Se o site bloquear automacao, pode ser necessario ajustar estrategia ou obter autorizacao/suporte do fornecedor.
- Dois operadores controlando o mesmo computador ao mesmo tempo podem gerar conflito; o MVP deve bloquear comandos simultaneos por dispositivo.
- Uma mesma conta usada simultaneamente em varios computadores pode ser derrubada pelo proprio site, dependendo das regras da plataforma.
- O sistema nao deve bloquear automaticamente o uso simultaneo do mesmo perfil em varios computadores, mas deve avisar claramente o risco e pedir confirmacao pelo menos duas vezes antes de prosseguir.
- Credenciais em `acesso.txt` sao um risco; devem ser migradas para segredo de ambiente.
- Screenshots podem conter informacoes sensiveis; precisam de controle de acesso.
- A estabilidade depende da internet da VPS e dos computadores locais.

## Criterios de Aceite do MVP

- Usuario acessa o painel web pela VPS.
- Usuario faz login no painel.
- Painel mostra pelo menos dois computadores cadastrados.
- Painel permite vincular computadores a uma radio/perfil de acesso.
- Cada agente aparece como online/offline corretamente.
- Usuario escolhe um computador e manda abrir o site.
- Agente abre o navegador local e acessa o site.
- Usuario dispara login ou reutiliza sessao existente.
- Se o perfil ja estiver ativo em outro computador, o painel mostra alerta de simultaneidade e exige duas confirmacoes antes de continuar.
- Usuario solicita screenshot e ve o estado atual.
- Historico registra comando, usuario, computador, horario e resultado.
- Se o agente cair, o painel mostra offline e ele reconecta automaticamente quando voltar.

## Proximas Decisoes

- Quais sistemas operacionais existem nos computadores que serao controlados?
- Quais acoes exatas do site precisam virar botoes no painel?
- Os dois locais controlam a mesma conta ou contas separadas?
- Devemos tratar cada radio como uma organizacao separada, com usuarios e permissoes proprias?
- O painel precisa ter niveis de permissao por usuario?
- Screenshot sob demanda e suficiente ou sera necessario streaming visual quase em tempo real?
- O navegador local deve ficar visivel na tela ou pode rodar minimizado/headless?
