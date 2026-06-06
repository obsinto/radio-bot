# Tutorial Resumido: Agente Windows 7

## 1. Copiar Credenciais

No painel, cadastre o computador em `Configuracoes > Computadores` e copie:

```text
DEVICE_ID=...
DEVICE_TOKEN=...
```

## 2. Copiar Para o Pendrive

No pendrive, copie a pasta:

```text
scripts\windows7\
```

No Windows 7, deixe assim:

```text
C:\RadioBOTInstaller\scripts\windows7\
```

## 3. Instalar

Abra o PowerShell no Windows 7:

```powershell
cd C:\RadioBOTInstaller
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\install-agent.ps1
```

Responda o instalador:

```text
Pasta de instalacao: C:\RadioBOTLegacy
URL da API: https://api.seu-dominio.com
Device ID do computador: cole o DEVICE_ID
Device token: cole o DEVICE_TOKEN
Caminho do Chrome: deixe vazio para detectar automaticamente ou informe o chrome.exe
Nome da tarefa agendada: RadioBOTLegacyAgent
Simular desligamento: nao
Porta local do Chrome DevTools: 9222
Intervalo de polling: 5
```

Exemplo de caminho do Chrome:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

Use a URL da API, nao a URL do painel, e nao precisa colocar `/agent`.

O agente abre o Chrome com uma porta local de automacao (`127.0.0.1:9222`) e um perfil separado em `C:\RadioBOTLegacy\chrome-profile`.

Ao abrir outra radio, o agente fecha as abas antigas do Chrome controlado. O esperado e manter sempre uma radio por computador.

O agente abre o Chrome com a politica de autoplay desabilitada, entao a radio comeca a tocar sozinha sem precisar de clique manual. Para isso funcionar, o Chrome desse perfil precisa ser aberto pelo agente. Se voce abriu o Chrome desse perfil manualmente, feche-o antes; a reinstalacao ja encerra o Chrome antigo do agente automaticamente.

## 4. Validar

Confira a tarefa:

```powershell
schtasks.exe /Query /TN RadioBOTLegacyAgent
```

Acompanhe os logs:

```powershell
Get-Content C:\RadioBOTLegacy\agent.log -Tail 80 -Wait
```

No painel, o computador deve aparecer `online`.

Teste primeiro:

1. `Estado`
2. `Captura de tela`
3. `Abrir e tocar`
4. `Play`
5. `Stop`

Durante a validacao, mantenha `Simular desligamento: sim`.

## 5. Atualizar Uma Instalacao Existente

Copie novamente a pasta `scripts\windows7\` atualizada para:

```text
C:\RadioBOTInstaller\scripts\windows7\
```

Rode o instalador de novo:

```powershell
cd C:\RadioBOTInstaller
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\install-agent.ps1
```

O instalador para a tarefa antiga, copia o novo runner e inicia o agente novamente.

Se o play nao funcionar, confira o log (agora cada comando concluido grava o resultado completo, incluindo `fallback`, `chromeError` e contagem de midia):

```powershell
Get-Content C:\RadioBOTLegacy\agent.log -Tail 80 -Wait
```

Para um diagnostico completo (flag de autoplay presente no Chrome em execucao, porta de debug aberta, abas e ultimas linhas do log), rode:

```powershell
cd C:\RadioBOTInstaller
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows7\diagnose-autoplay.ps1
```

Copie toda a saida para analisar. Os pontos decisivos sao: a flag `--autoplay-policy=no-user-gesture-required` aparece no processo Chrome? A porta `9222` responde? No ultimo `play_radio`, o log mostra `fallback=true` (CDP nao conectou) ou `fallback=false` (CDP funcionou)?
