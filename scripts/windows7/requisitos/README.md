# Requisitos do Agente Legado (Windows 7)

Instaladores offline necessários para um Windows 7 zerado rodar o agente
(`run-agent.ps1`). Ficam aqui para não precisar caçar e baixar toda vez — um
Win7 sem TLS 1.2 muitas vezes nem consegue baixá-los sozinho.

> Versionados via **Git LFS**. Em um clone novo: `git lfs install && git lfs pull`.

## Arquivos

| Arquivo | O que é | Por quê |
|---|---|---|
| `windows6.1-kb4490628-x64...msu` | Servicing Stack Update | Pré-requisito para a atualização SHA-2 |
| `windows6.1-kb4474419-v3-x64...msu` | Suporte a assinatura SHA-2 | Sem ele o Win7 rejeita a assinatura dos instaladores novos (WMF/.NET) |
| `ndp48-web.exe` | .NET Framework 4.8 (web) | Runtime + TLS 1.2 (WMF 5.1 exige .NET 4.5+). Precisa de internet ao instalar |
| `Win7AndW2K8R2-KB3191566-x64.zip` | WMF 5.1 | Fornece PowerShell 5.1 |
| `ChromeSetup.exe` | Google Chrome (web) | Navegador controlado por CDP. Precisa de internet ao instalar |

## Ordem de instalação

1. `windows6.1-kb4490628-x64...msu`  → reiniciar
2. `windows6.1-kb4474419-v3-x64...msu` → reiniciar
3. `ndp48-web.exe` (.NET 4.8) → reiniciar
4. WMF 5.1: extrair o `.zip` e rodar `Install-WMF5.1.ps1` (ou o `.msu` interno) → reiniciar
5. `ChromeSetup.exe`
6. Conferir: `powershell -Command "$PSVersionTable.PSVersion"` (deve ser 5.1)

Depois disso, seguir o `docs/WINDOWS7_LEGACY_AGENT_QUICKSTART.md`.

## Links oficiais (fonte)

- KB4490628 (SSU): https://www.catalog.update.microsoft.com/Search.aspx?q=KB4490628
- KB4474419 (SHA-2): https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419
- WMF 5.1 (KB3191566): https://www.microsoft.com/en-us/download/details.aspx?id=54616
- .NET Framework 4.8: https://dotnet.microsoft.com/download/dotnet-framework/net48
- Google Chrome: https://www.google.com/chrome/
