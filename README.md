# GrafiFlow

Aplicativo web progressivo para orçamento e aproveitamento de bobinas e chapas. A aplicação continua funcionando offline no Windows e no Android; os dados locais são mantidos no IndexedDB e podem ser exportados em backup.

## Stack

- **GitHub:** repositório privado do código.
- **Vercel:** publicação do app estático/PWA.
- **Supabase:** autenticação por e-mail, espaços de trabalho, sincronização entre dispositivos, RLS e estrutura inicial de assinaturas.

O núcleo de cálculo não depende de conexão. A nuvem é uma camada opcional: quando o usuário entra e há internet, o GrafiFlow sincroniza rascunho, catálogo e orçamentos; alterações offline entram em uma fila local e são enviadas ao reconectar.

## Publicação na Vercel

1. Configure no projeto Vercel as variáveis `GRAFIFLOW_SUPABASE_URL` e `GRAFIFLOW_SUPABASE_ANON_KEY`.
2. Use `npm run build` como comando de build e `build` como diretório de saída (já definido em `vercel.json`).
3. A chave `anon` do Supabase é uma chave pública para uso no navegador. **Nunca configure `service_role` no front-end ou na Vercel como variável exposta ao cliente.** As regras RLS protegem os dados.

Sem as duas variáveis, o app é publicado e funciona localmente, mas a conta e a sincronização em nuvem ficam desativadas.

## Supabase

Aplique `supabase/migrations/202610030001_grafiflow_core.sql` no projeto Supabase. A migração cria perfis, espaços de trabalho, membros, registros sincronizados, políticas RLS e uma tabela neutra de assinaturas. Cada conta nova recebe seu próprio espaço de trabalho. A tabela de assinatura ainda não ativa cobrança nem define planos/preços.

Configure a URL do site publicado nas URLs de redirecionamento/autorização do Supabase. O app usa autenticação por e-mail e senha; conforme a configuração de confirmação de e-mail do projeto, o usuário pode precisar confirmar o endereço antes do primeiro acesso.

## Configuração inicial das plataformas

1. Crie um repositório **privado** no GitHub e envie o conteúdo deste pacote mantendo `dist/`, `scripts/` e `supabase/` na raiz.
2. No Supabase, crie um projeto e execute o SQL da migração acima. Copie a Project URL e a chave pública `anon`/publishable.
3. Na Vercel, importe o repositório do GitHub. O projeto já define `npm run build` e a pasta `build` como saída.
4. Nas variáveis de ambiente da Vercel, defina `GRAFIFLOW_SUPABASE_URL` e `GRAFIFLOW_SUPABASE_ANON_KEY` e publique novamente.
5. Abra o endereço publicado, crie uma conta GrafiFlow e teste cadastro, sincronização entre dois dispositivos e uso offline.

Os dados locais do site antigo pertencem à origem antiga do navegador. Exporte um backup nele e importe no novo GrafiFlow para levar catálogo e orçamentos; a primeira sincronização enviará os dados importados à conta conectada.

## Assinaturas

A migração prepara a tabela de assinaturas e o isolamento por espaço de trabalho, mas ainda não configura planos, checkout, cobrança recorrente, webhooks do provedor nem bloqueio de recursos por plano. Esses passos dependem da escolha do provedor e dos preços; não há cobrança ativa neste pacote.

## Desenvolvimento local

```sh
npm run build
npm run preview
```

Para testar sincronização, defina as duas variáveis de ambiente antes do build. Para testar somente o cálculo/offline, elas podem ficar vazias.
