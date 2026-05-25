# Plano: configurar ESP32 ja flashado pelo navegador

## Objetivo

Permitir que o operador configure um ESP32 WOL Gateway pelo proprio painel web em producao, usando USB e navegador, sem editar `.env`, `config.h` ou rodar PlatformIO para cada unidade.

"ESP32 ja flashado" significa que o dispositivo ja recebeu uma vez o firmware base do `firmware/esp32-wol-gateway`. Este plano nao cobre gravar firmware do zero pelo navegador.

## Resultado esperado

1. Operador abre o painel em producao.
2. Entra em `Configuracoes > Gateways WOL`.
3. Clica em `Configurar ESP32 via USB`.
4. O painel cria ou seleciona um gateway e obtem `WOL_GATEWAY_ID` + `WOL_GATEWAY_TOKEN`.
   - Se selecionar gateway existente, o painel rotaciona o token antes de configurar.
5. Operador conecta o ESP32 no USB do computador.
6. Navegador pede permissao para acessar a porta serial.
7. Painel mostra e valida a URL da API que sera gravada no ESP32.
8. Painel envia Wi-Fi, URL da API, gateway ID e token para o ESP32.
9. ESP32 salva a configuracao em memoria persistente e reinicia.
10. Painel consulta `status` via serial e aguarda o gateway aparecer online.

## Escopo

Incluido:

- Configuracao via Web Serial em Chrome, Edge ou Brave desktop.
- Firmware lendo configuracao de memoria persistente (`Preferences`/NVS).
- Protocolo serial simples com JSON por linha.
- Wizard no painel para configurar e validar gateway.
- Documentacao de uso e troubleshooting.

Fora do escopo nesta fase:

- Flash do firmware pelo navegador usando `esptool-js`.
- Suporte mobile/iOS.
- Configuracao por Bluetooth.
- Captive portal Wi-Fi no ESP32.

## Estado atual

O firmware atual usa valores fixos em `include/config.h`:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `API_BASE_URL`
- `WOL_GATEWAY_ID`
- `WOL_GATEWAY_TOKEN`

Isso exige rebuild/reflash quando muda Wi-Fi, API ou credenciais do gateway. Para configurar pelo painel, esses valores precisam sair do build e passar a ser gravados em runtime.

## Arquitetura proposta

### Firmware

Adicionar um modulo de configuracao persistente:

- Namespace NVS: `radio_bot`
- Chaves:
  - `wifi_ssid`
  - `wifi_password`
  - `api_base_url`
  - `gateway_id`
  - `gateway_token`
  - `configured_at`

Comportamento no boot:

1. Inicializar Serial.
2. Ler configuracao salva.
3. Se incompleta, entrar em modo `waiting_config`.
4. Se completa, conectar ao Wi-Fi e iniciar polling da API.
5. Enquanto rodando, continuar aceitando comandos seriais de status/reconfiguracao.

### Protocolo serial

Usar JSON por linha (`\n`) a 115200 baud.

Comando `hello`:

```json
{"type":"hello"}
```

Resposta:

```json
{
  "type":"hello_result",
  "ok":true,
  "protocolVersion":1,
  "firmwareVersion":"0.1.0",
  "configured":false,
  "chipId":"..."
}
```

Comando `configure`:

```json
{
  "type":"configure",
  "wifiSsid":"Rede da radio",
  "wifiPassword":"senha",
  "apiBaseUrl":"https://radio-api.exemplo.com",
  "gatewayId":"esp-studio-01",
  "gatewayToken":"token-gerado-no-painel"
}
```

Resposta:

```json
{"type":"configure_result","ok":true,"saved":true,"restarting":true}
```

Comando `status`:

```json
{"type":"status"}
```

Resposta:

```json
{
  "type":"status_result",
  "ok":true,
  "configured":true,
  "wifiConnected":true,
  "ip":"192.168.1.50",
  "lastError":null,
  "apiBaseUrl":"https://radio-api.exemplo.com",
  "gatewayId":"esp-studio-01",
  "gatewayTokenSet":true
}
```

Comando `reset_config`:

```json
{"type":"reset_config"}
```

Resposta:

```json
{"type":"reset_config_result","ok":true,"cleared":true,"restarting":true}
```

Nunca retornar `wifiPassword` nem `gatewayToken` em respostas.

### Painel web

Adicionar um wizard na aba `Gateways WOL`.

Passos:

1. `Gateway`
   - Criar novo gateway ou escolher existente.
   - Para gateway novo, exibir o token somente durante o wizard.
   - Para gateway existente, rotacionar token antes de enviar para o ESP32.
2. `USB`
   - Botao `Conectar ESP32`.
   - Usar `navigator.serial.requestPort()`.
   - Abrir porta com baud rate 115200.
   - Aguardar reset automatico do ESP32 apos abrir a porta.
   - Enviar `hello` com retries e validar `protocolVersion`.
3. `Wi-Fi`
   - Campos `SSID` e `Senha`.
   - `API_BASE_URL` preenchido automaticamente pela configuracao do app.
   - Exibir a URL da API antes de gravar.
   - Validar que a URL aponta para a API, nao para o painel web.
4. `Gravar`
   - Enviar comando `configure`.
   - Exibir progresso e resposta do ESP32.
5. `Validar`
   - Consultar `status` via serial depois do reboot.
   - Aguardar API marcar gateway online.
   - Mostrar estado final: online/offline, IP se vier pelo serial, ultimo contato.

Estados de erro:

- Navegador nao suporta Web Serial.
- Usuario cancelou selecao da porta.
- Porta serial ocupada.
- ESP32 nao respondeu `hello`.
- Firmware antigo sem suporte a configuracao serial.
- Versao de protocolo serial incompativel.
- Wi-Fi nao conecta.
- API retorna credenciais invalidas.
- Gateway nao aparece online apos timeout.

## Backend/API

O backend ja cria gateway e retorna token uma vez. Para o wizard, adicionar ou confirmar:

- Endpoint atual `POST /api/wol-gateways` continua sendo a fonte do token.
- Estado do gateway em `/api/state` continua indicando online/offline.
- Endpoint obrigatorio `POST /api/wol-gateways/:id/rotate-token` para reconfigurar ESP32 existente sem recriar gateway.
- Endpoint de rotacao deve retornar o novo token apenas na resposta da rotacao.

Regras:

- Token so deve aparecer no momento da criacao ou rotacao.
- Se o wizard falhar depois de criar ou rotacionar gateway, permitir tentar configurar novamente enquanto o token ainda estiver em memoria no frontend.
- Se a pagina for recarregada, token deve ser considerado perdido e operador precisa criar ou rotacionar outro token.
- Rotacionar token invalida automaticamente qualquer ESP32 configurado anteriormente com o token antigo.

## Firmware: tarefas

- [x] Criar struct `GatewayConfig`.
- [x] Adicionar leitura/escrita em `Preferences`.
- [x] Trocar `API_BASE_URL`, `WOL_GATEWAY_ID`, `WOL_GATEWAY_TOKEN`, `WIFI_SSID` e `WIFI_PASSWORD` por valores de runtime.
- [x] Manter fallback opcional para `config.h` apenas como seed inicial.
- [x] Implementar parser JSON por linha na Serial.
- [x] Implementar comandos `hello`, `status`, `configure` e `reset_config`.
- [x] Incluir `protocolVersion` no `hello_result`.
- [x] Retornar `lastError` no `status` sem expor senha ou token.
- [x] Validar tamanho maximo dos campos antes de salvar.
- [x] Reiniciar Wi-Fi depois de salvar configuracao.
- [x] Garantir que token e senha nunca sejam impressos no log.
- [x] Atualizar `platformio.ini` se precisar de bibliotecas extras.

## Web: tarefas

- [x] Criar componente `Esp32Configurator`.
- [x] Detectar suporte a `navigator.serial`.
- [x] Criar fluxo de conectar/desconectar porta.
- [x] Aguardar reset automatico do ESP32 apos abrir a porta serial.
- [x] Implementar leitura de mensagens JSON por linha.
- [x] Implementar envio de comandos serial.
- [x] Implementar retries para `hello` com timeout.
- [x] Validar `protocolVersion` antes de permitir configuracao.
- [x] Integrar wizard na aba `Gateways WOL`.
- [x] Preencher `apiBaseUrl` automaticamente usando a URL da API configurada no frontend.
- [x] Exibir e validar `apiBaseUrl` antes de gravar, evitando URL do painel web.
- [x] Criar fluxo de novo gateway com token temporario.
- [x] Criar fluxo obrigatorio de rotacao de token para gateway existente.
- [x] Criar validacao visual ate o gateway aparecer online.
- [x] Tratar erros de permissao, timeout e firmware incompatvel.

## UX

Tela sugerida:

- Titulo: `Configurar ESP32 via USB`
- Etapas visuais: `Gateway`, `USB`, `Wi-Fi`, `Gravar`, `Validar`
- Botoes:
  - `Criar gateway`
  - `Conectar ESP32`
  - `Gravar configuracao`
  - `Testar conexao`
  - `Limpar configuracao do ESP32`

Texto operacional curto:

- `Conecte o ESP32 ao USB deste computador.`
- `O navegador pedira permissao para acessar a porta serial.`
- `O token sera exibido somente durante esta configuracao.`
- `Confira a URL da API antes de gravar.`
- `Ao reconfigurar um gateway existente, o token antigo sera invalidado.`

## Seguranca

- Nao salvar senha Wi-Fi ou token no localStorage.
- Nao exibir token depois que o wizard for fechado.
- Nao logar payload completo no console.
- Exibir token mascarado depois de gravado.
- Confirmar antes de `reset_config`.
- Usar HTTPS em producao, requisito do Web Serial.

## Validacao manual

1. Gravar firmware base no ESP32 uma vez via PlatformIO.
2. Apagar NVS ou usar `reset_config`.
3. Abrir painel em producao no Chrome.
4. Criar gateway pelo wizard.
5. Conectar ESP32 via USB.
6. Confirmar que `hello_result.protocolVersion` e aceito.
7. Conferir a URL da API exibida pelo wizard.
8. Enviar configuracao.
9. Confirmar que ESP32 reinicia.
10. Consultar `status` via serial e confirmar `wifiConnected`.
11. Confirmar no painel que gateway fica online.
12. Associar computador ao gateway.
13. Clicar em `Ligar computador`.
14. Conferir envio do magic packet e resultado do comando.

## Riscos

- Web Serial nao funciona em todos os navegadores.
- Driver USB/serial pode faltar no Windows.
- ESP32 pode estar com firmware antigo sem protocolo serial.
- Token se perde se operador recarregar a pagina antes de gravar.
- Rotacionar token de gateway existente derruba ESP32 configurado com token antigo ate reconfigurar.
- URL errada do painel web gravada como API impede o gateway de autenticar.
- Wi-Fi corporativo pode bloquear o ESP32 de acessar a API publica.

## Futuro

Depois deste fluxo estar estavel, implementar `Preparar ESP32 do zero`:

- Gerar binario do firmware em CI.
- Servir binario pelo app.
- Usar `esptool-js` no navegador.
- Gravar firmware e configuracao no mesmo wizard.
