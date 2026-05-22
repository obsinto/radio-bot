# Plano de Implementacao - Agendamento, Stop e Oliveira FM

## Objetivo

Adicionar ao Radio BOT recursos para:

- Ligar um computador em horario configurado e iniciar automaticamente a radio.
- Desligar um computador em horario configurado.
- Parar a reproducao que estiver ativa no navegador controlado pelo agente.
- Cadastrar/usar a Oliveira FM em `https://www.oliveirafm.com.br/` e acionar o play do player.

## Status de implementacao

- [x] Criar `plan.md` com escopo tecnico das entregas.
- [x] Adicionar comandos `play_radio`, `stop_playback` e `shutdown` ao contrato compartilhado.
- [x] Implementar `play_radio` no agente local com clique em seletores configurados/genericos e fallback para `audio`/`video`.
- [x] Implementar `stop_playback` no agente local pausando `audio`/`video` e tentando botoes de pause/stop.
- [x] Implementar `shutdown` no agente local usando comandos allowlistados do sistema operacional.
- [x] Adicionar botoes `Play`, `Stop` e `Desligar` no painel.
- [x] Adicionar confirmacao antes de enviar `shutdown`.
- [x] Ajustar API para nao exigir confirmacao de conflito em `stop_playback`, `shutdown`, `screenshot` e `get_state`.
- [x] Criar persistencia e endpoints de agendamentos.
- [x] Implementar scheduler da API.
- [x] Implementar rotina agendada `power_on_start`.
- [x] Implementar rotina agendada `shutdown`.
- [x] Adicionar UI de agendamentos no painel.
- [x] Adicionar preset/documentacao da Oliveira FM.
- [x] Validar manualmente o player real da Oliveira FM.
- [x] Rodar `npm run typecheck` apos a primeira etapa de comandos.
- [x] Rodar `npm run typecheck` apos backend, UI e docs de agendamento.
- [x] Rodar `npm run build` completo.
- [x] Testar CRUD basico de agendamentos via Fastify `inject`.
- [x] Adicionar `SHUTDOWN_DRY_RUN` no agente para validar desligamento sem desligar a maquina.
- [x] Testar fluxo API -> WebSocket de agente simulado -> rotinas `power_on_start` e `shutdown`.
- [x] Rodar `npm run typecheck` e `npm run build` apos `SHUTDOWN_DRY_RUN` e validacao simulada.
- [ ] Testar fluxo ponta a ponta com painel no navegador, agente Playwright real, WOL real e sem acionar desligamento indevido.

Validacao Oliveira FM: em teste Playwright no site real, a pagina expos um `<audio>` com stream `https://hts09.brascast.com:11932/live` e o fallback `audio.play()` iniciou a reproducao com `paused=false`.
Validacao API: login, criacao, atualizacao e listagem de agendamento retornaram HTTP 200/201 usando store em memoria.
Validacao fluxo simulado: com servidor real e WebSocket de agente simulado, `run-now` de ligar/tocar enviou `open_site` e `play_radio`; `run-now` de desligar enviou `shutdown`; as duas execucoes finalizaram como `succeeded`.

## Estado atual do projeto

O projeto ja tem as bases necessarias para essa evolucao:

- `apps/api`: API Fastify com comandos, estado, WebSocket para agentes, PostgreSQL opcional e Wake-on-LAN.
- `apps/web`: painel React com selecao de radio/computador, botoes de comando e configuracao WOL.
- `apps/agent`: agente local com Playwright controlando Chromium persistente.
- `firmware/esp32-wol-gateway`: gateway ESP32 que recebe comandos `power_on` e envia magic packet.
- `packages/shared`: contrato de tipos e lista de `COMMAND_ACTIONS`.

O plano abaixo parte da arquitetura atual e evita executar comandos de sistema arbitrarios pelo painel.

## Premissas e limites tecnicos

- "Ligar computador" deve usar Wake-on-LAN pelo ESP32 ja existente. Para computador totalmente desligado, WOL depende de BIOS/UEFI, placa de rede, cabo Ethernet e energia ativa.
- Se o computador estiver sem energia ou WOL estiver desabilitado, o sistema deve registrar falha e orientar configuracao local.
- "Abrir automaticamente tudo" significa executar uma sequencia apos o computador ficar online: ligar via WOL, aguardar o agente conectar, abrir site, fazer login quando necessario e tocar a radio.
- "Desligar computador" deve ser executado pelo agente local online. Um computador offline nao consegue receber comando de desligamento.
- O comando de stop deve atuar no navegador/perfil controlado pelo Radio BOT, nao em todos os programas do sistema operacional.
- A Oliveira FM sera tratada inicialmente como perfil de link direto, sem credenciais.

## Modelo funcional esperado

### Agendamento de ligar e iniciar

Fluxo:

1. Operador cria um agendamento no painel informando computador, radio, horario, timezone e dias da semana.
2. API persiste o agendamento.
3. Scheduler da API dispara no horario configurado.
4. API cria comando `power_on`.
5. Gateway ESP32 envia Wake-on-LAN.
6. API aguarda o agente do computador ficar online dentro de uma janela configuravel.
7. Quando o agente conecta, API envia a sequencia:
   - `open_site` ou `login`, conforme o perfil.
   - `play_radio`.
   - `get_state` ou `screenshot` opcional para auditoria.
8. Historico mostra cada etapa e o resultado final da rotina.

### Agendamento de desligar

Fluxo:

1. Operador cria agendamento de desligamento para um computador.
2. API dispara no horario.
3. Se o agente estiver online, API envia `shutdown`.
4. Agente executa o desligamento usando comando permitido por sistema operacional.
5. API registra sucesso/falha.

### Stop

Fluxo:

1. Operador clica em `Stop`.
2. API envia `stop_playback` ao agente.
3. Agente pausa elementos `audio`/`video`, tenta clicar no botao de pause/stop do player ativo e opcionalmente fecha a pagina controlada.
4. Estado do computador e historico sao atualizados.

### Oliveira FM

Fluxo:

1. Perfil `Oliveira FM` aponta para `https://www.oliveirafm.com.br/`.
2. Operador seleciona esse perfil e um computador.
3. Ao clicar em abrir/tocar, agente abre o site e executa `play_radio`.
4. Automacao tenta:
   - Liberar prompt de autoplay, se o navegador exigir clique.
   - Encontrar player no documento principal ou em iframes.
   - Clicar em botao com texto/atributos de play.
   - Como fallback, executar `play()` em elementos `audio`/`video`.
5. Resultado deve informar se audio/video ficou em reproducao ou qual seletor falhou.

## Alteracoes em `packages/shared`

- Adicionar novos comandos em `COMMAND_ACTIONS`:
  - `play_radio`
  - `stop_playback`
  - `shutdown`
- Adicionar tipos para agendamentos:
  - `ScheduleKind = "power_on_start" | "shutdown"`
  - `ScheduleStatus = "enabled" | "disabled"`
  - `ScheduleRecord`
  - `ScheduleRunRecord`
- Estender `DashboardState` para incluir agendamentos e ultimas execucoes, se o painel precisar exibir isso no estado principal.
- Definir payloads tipados para:
  - `play_radio`: `{ closeOtherPages?: boolean }`
  - `stop_playback`: `{ closePage?: boolean }`
  - `shutdown`: `{ delaySeconds?: number; force?: boolean }`

## Alteracoes na API

### Persistencia

Criar tabelas no `PostgresStore.migrate()`:

- `schedules`
  - `id`
  - `name`
  - `kind`
  - `device_id`
  - `profile_id`
  - `timezone`
  - `time_of_day`
  - `days_of_week`
  - `enabled`
  - `last_run_at`
  - `next_run_at`
  - `created_at`
  - `updated_at`
- `schedule_runs`
  - `id`
  - `schedule_id`
  - `started_at`
  - `finished_at`
  - `status`
  - `error`
  - `command_ids`

No `AppStore` em memoria, implementar as mesmas operacoes para desenvolvimento local.

### Endpoints

Adicionar endpoints autenticados:

- `GET /api/schedules`
- `POST /api/schedules`
- `PATCH /api/schedules/:scheduleId`
- `DELETE /api/schedules/:scheduleId`
- `POST /api/schedules/:scheduleId/run-now`
- `GET /api/schedules/:scheduleId/runs`

Validacoes:

- `deviceId` precisa existir.
- `profileId` precisa existir quando `kind = "power_on_start"`.
- Computador precisa estar vinculado ao perfil escolhido.
- Timezone deve ser valida.
- Dias da semana devem ser `0` a `6` ou enum equivalente.
- Nao permitir `shutdown` sem confirmacao explicita no frontend.

### Scheduler

Implementar um servico interno da API, por exemplo `apps/api/src/scheduler.ts`.

Responsabilidades:

- Calcular `next_run_at` usando timezone do agendamento.
- Fazer polling a cada 15-30 segundos por agendamentos vencidos.
- Marcar execucao em andamento antes de disparar comandos para evitar duplicidade.
- Em ambiente com mais de uma instancia da API, usar lock no PostgreSQL com `FOR UPDATE SKIP LOCKED`.
- Recalcular `next_run_at` depois da execucao.
- Registrar `schedule_runs`.

Para evitar dependencias prematuras, o calculo pode comecar simples com horario/dias e `Intl`. Se ficar complexo, usar biblioteca de cron/timezone.

### Execucao de rotina `power_on_start`

Implementar orquestracao na API:

1. Criar comando `power_on`.
2. Aguardar resultado do gateway WOL ou pelo menos aguardar o dispositivo ficar online.
3. Esperar o agente conectar por ate `POWER_ON_WAIT_SECONDS`, padrao 180.
4. Enviar `open_site` ou `login`.
5. Enviar `play_radio`.
6. Registrar falha clara se algum passo falhar.

Importante: hoje os comandos sao enviados de forma imediata quando o agente esta online. Para rotinas, sera necessario criar um helper de envio que consiga aguardar conclusao de um comando antes de enviar o proximo.

### Execucao de rotina `shutdown`

Validar que o agente esta online e enviar comando `shutdown`.

Se o dispositivo estiver offline:

- Registrar run como falho.
- Nao tentar WOL.
- Exibir no painel que o computador ja esta offline ou indisponivel.

## Alteracoes no agente

### `play_radio`

Adicionar em `BrowserController.execute()`:

- Garantir pagina aberta com `ensurePage(profile)`.
- Se a pagina estiver em branco ou em outra URL, chamar `openSite(profile)`.
- Tentar play com uma estrategia em camadas:
  - Clicar em seletores configurados por perfil/acao via `ACTION_MAP_JSON`, exemplo `oliveira-fm.play`.
  - Procurar botoes comuns: `button[aria-label*="play" i]`, `.play`, `.btn-play`, `[data-action*="play" i]`, texto `Play`, `Ouvir`, `Ao vivo`.
  - Procurar dentro de frames com `page.frames()`.
  - Executar `HTMLMediaElement.play()` em `audio, video`.
- Retornar no `output`:
  - seletor/estrategia usada;
  - URL atual;
  - quantidade de elementos de media encontrados;
  - se algum elemento ficou `!paused`.

### `stop_playback`

Adicionar em `BrowserController.execute()`:

- Pausar todos os `audio` e `video` no documento e frames.
- Tentar clicar em botoes comuns de pause/stop.
- Se `payload.closePage === true`, fechar a pagina atual depois de pausar.
- Limpar `currentProfileId` quando fechar a pagina.
- Retornar quantos elementos foram pausados e se a pagina foi fechada.

### `shutdown`

Adicionar um executor local allowlistado:

- Windows:
  - `shutdown.exe /s /t <delaySeconds>`
  - se `force = true`, adicionar `/f`
- Linux:
  - preferir `systemctl poweroff` quando disponivel;
  - fallback `shutdown -h +0` ou `shutdown -h now`.

Regras:

- Usar `child_process.execFile`, nao shell livre.
- Limitar `delaySeconds` a um intervalo seguro, por exemplo `0` a `3600`.
- Registrar comando e sistema operacional no output.
- Documentar permissoes necessarias do servico do agente.

## Alteracoes no painel web

### Botoes de comando

Adicionar no `commandButtons`:

- `Play` com icone `Play`.
- `Stop` com icone `Square` ou `Pause`.
- `Desligar` com icone `Power`, exigindo modal de confirmacao.

Comportamento:

- `Play` envia `play_radio`.
- `Stop` envia `stop_playback`.
- `Desligar` envia `shutdown` apenas com confirmacao.
- `Stop` e `Desligar` exigem agente online.
- `Ligar computador` continua disponivel offline quando houver WOL configurado.

### Tela de agendamentos

Adicionar uma secao/modal `Agendamentos`:

- Lista de agendamentos ativos/inativos.
- Criar agendamento de ligar e iniciar.
- Criar agendamento de desligar.
- Campos:
  - Nome.
  - Computador.
  - Radio, apenas para ligar e iniciar.
  - Horario.
  - Dias da semana.
  - Timezone, padrao `America/Sao_Paulo`.
  - Ativo/inativo.
- Acao `Executar agora` para teste manual.
- Mostrar ultima execucao e proxima execucao.

### Oliveira FM

Adicionar caminho facil no cadastro de radio:

- Botao ou preset `Oliveira FM`.
- Preencher:
  - Nome: `Oliveira FM`
  - URL: `https://www.oliveirafm.com.br/`
  - Tipo: `Link direto`
- Permitir vincular o perfil a qualquer computador.

## Configuracao e seed

Atualizar `.env.example`, `README.md` e docs relevantes:

```json
SITE_PROFILES_JSON=[
  {
    "id": "oliveira-fm",
    "name": "Oliveira FM",
    "siteUrl": "https://www.oliveirafm.com.br/",
    "username": "",
    "password": ""
  }
]
```

Exemplo de `ACTION_MAP_JSON` para ajuste depois da inspecao real do player:

```json
{
  "oliveira-fm.play": "button[aria-label*=\"play\" i]",
  "oliveira-fm.stop": "button[aria-label*=\"pause\" i]"
}
```

Durante a implementacao, validar os seletores reais com Playwright porque o site pode renderizar o player via JavaScript ou iframe.

## Testes

### Unitarios / typecheck

- `npm run typecheck`
- Testes de validacao dos payloads de agendamento.
- Testes de calculo de `next_run_at`.
- Testes de validacao de novos comandos.

### Integracao API

- Criar agendamento.
- Atualizar/desativar agendamento.
- Executar `run-now`.
- Garantir que agendamento `power_on_start` cria os comandos na ordem correta.
- Garantir que `shutdown` falha quando computador esta offline.
- Garantir que nao ha duplicidade de execucao quando o scheduler roda duas vezes.

### Agente

- Testar `play_radio` em uma pagina local com `<audio>` e botao de play.
- Testar `stop_playback` pausando `<audio>`/`<video>`.
- Testar `shutdown` com mock de `execFile`.
- Testar que comandos desconhecidos continuam falhando.

### Teste manual Oliveira FM

1. Rodar API, web e agent local.
2. Cadastrar perfil Oliveira FM com URL `https://www.oliveirafm.com.br/`.
3. Vincular ao computador local.
4. Clicar em abrir.
5. Clicar em play.
6. Capturar screenshot.
7. Clicar em stop e confirmar que a reproducao parou.
8. Criar agendamento `Executar agora` para validar a rotina completa.

## Ordem sugerida de implementacao

1. [x] Adicionar comandos `play_radio`, `stop_playback` e `shutdown` nos tipos compartilhados.
2. [x] Implementar `play_radio` e `stop_playback` no agente.
3. [x] Adicionar botoes `Play` e `Stop` no painel.
4. [x] Adicionar `shutdown` no agente e botao com confirmacao no painel.
5. [x] Criar modelo, endpoints e persistencia de agendamentos.
6. [x] Implementar scheduler da API.
7. [x] Implementar rotina `power_on_start` com espera do agente e sequencia de comandos.
8. [x] Adicionar preset/documentacao da Oliveira FM.
9. [x] Validar manualmente o player real da Oliveira FM e ajustar `ACTION_MAP_JSON` ou seletores internos.
10. [ ] Rodar typecheck e testes manuais de ponta a ponta.

## Riscos

- WOL pode nao funcionar em Wi-Fi ou quando a maquina estiver sem energia.
- Navegadores bloqueiam autoplay sem interacao do usuario; por isso o `play_radio` deve sempre simular clique real.
- O player da Oliveira FM pode estar dentro de iframe ou mudar seletores sem aviso.
- Desligamento exige permissoes adequadas do processo do agente.
- Scheduler em multiplas replicas da API exige lock no banco para evitar execucao duplicada.

## Criterios de aceite

- Operador consegue cadastrar um horario para ligar um computador e iniciar a Oliveira FM automaticamente.
- Operador consegue cadastrar um horario para desligar um computador online.
- Painel mostra agendamentos, proxima execucao e historico das execucoes.
- Botao `Stop` para a reproducao no navegador controlado pelo agente.
- Perfil Oliveira FM fica disponivel como link direto e o comando `Play` aciona o player.
- Falhas de WOL, agente offline, player nao encontrado e desligamento negado aparecem claramente no historico.
- `npm run typecheck` passa.
