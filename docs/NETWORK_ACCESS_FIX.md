# Correção de Acesso na Rede Local

Se você encontrou o erro "failed to fetch" ao tentar acessar o painel do Radio-BOT através de um tablet ou outro dispositivo na mesma rede, este documento detalha as alterações feitas para resolver o problema.

## O Problema
O frontend estava configurado para buscar a API em `http://localhost:3000`. Quando acessado de um dispositivo externo (como um tablet), `localhost` aponta para o próprio dispositivo, resultando em falha na conexão.

## Alterações Realizadas

### 1. Configuração do Vite (`apps/web/vite.config.ts`)
O Vite foi configurado para carregar as variáveis de ambiente a partir da raiz do projeto. Isso permite que o frontend reconheça o `VITE_API_URL` definido no arquivo `.env` principal.

```typescript
// apps/web/vite.config.ts
export default defineConfig({
  // ...
  envDir: "../../",
  // ...
});
```

### 2. Fallback Dinâmico da API (`apps/web/src/api.ts`)
A lógica de definição da `API_URL` foi atualizada para detectar automaticamente o hostname de onde o painel está sendo carregado.

```typescript
// apps/web/src/api.ts
const API_URL =
  import.meta.env.VITE_API_URL ??
  `${window.location.protocol}//${window.location.hostname}:3000`;
```

## Como usar agora

1. **Acesso via IP:** Use o endereço IP do seu computador na rede local para acessar o painel no tablet.
   * Exemplo: `http://192.168.1.174:5173`
2. **Configuração Manual (Opcional):** Se preferir fixar um endereço, você pode editar o arquivo `.env` na raiz do projeto:
   ```env
   VITE_API_URL=http://192.168.1.174:3000
   ```
3. **Reinicialização:** Certifique-se de reiniciar o serviço do frontend após as alterações:
   ```bash
   npm run dev:web
   ```

## Dicas de Troubleshooting
* **Firewall:** Verifique se o firewall do seu sistema operacional permite tráfego nas portas `3000` (API) e `5173` (Painel).
* **Mesma Rede:** Certifique-se de que o tablet e o computador estão conectados à mesma rede Wi-Fi/LAN.
