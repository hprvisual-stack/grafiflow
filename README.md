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

Aplique, nesta ordem, `supabase/migrations/202610030001_grafiflow_core.sql`, `supabase/migrations/202610040001_account_profiles.sql`, `supabase/migrations/202610060001_sync_conflict_versions.sql`, `supabase/migrations/202610070001_incremental_sync_catalog_types.sql` e `supabase/migrations/20261029085324_customer_records.sql` no projeto Supabase. A primeira migração cria perfis, espaços de trabalho, membros, registros sincronizados, políticas RLS e uma tabela neutra de assinaturas; a segunda adiciona os dados de cadastro e preenchimento de orçamento ao perfil privado do titular; a terceira usa versões geradas pelo servidor para rejeitar gravações baseadas em uma versão remota antiga; a quarta cria um cursor incremental seguro para a sincronização, separa acabamentos, insumos, mão de obra e extras em tipos próprios e migra os itens existentes; a quinta cria os registros de clientes. Sem a quarta migração, o app mantém compatibilidade com o formato antigo e continua fazendo a carga completa dos registros.

O PWA busca apenas registros alterados desde o último cursor do espaço de trabalho. A carga inicial continua trazendo todos os registros, em páginas; exclusões permanecem como marcadores para que também sejam propagadas. O cursor usa sequência gerada pelo banco e gravações do mesmo espaço são serializadas para não pular alterações concorrentes.

Configure `https://grafiflow.vercel.app` como Site URL e permita essa origem nas Redirect URLs. Em Auth > Providers > Email, mantenha a confirmação de e-mail ativada. Em Auth > Email Templates, use `{{ .ConfirmationURL }}` como destino de um botão “Confirmar cadastro” no modelo Confirm Signup e um botão “Redefinir senha” no modelo Reset Password. Para entrega confiável de mensagens a usuários reais, configure SMTP próprio em Auth > SMTP Settings; o envio padrão do Supabase é restrito e não é adequado para produção.

Ao informar um CEP completo em Minha conta, o GrafiFlow consulta o ViaCEP e sugere rua, bairro, cidade e UF. Só o CEP é enviado ao serviço; número e complemento continuam sendo preenchidos pelo usuário, e os demais campos podem ser editados.

## Configuração inicial das plataformas

1. Crie um repositório **privado** no GitHub e envie o conteúdo deste pacote mantendo `dist/`, `scripts/` e `supabase/` na raiz.
2. No Supabase, crie um projeto e execute o SQL da migração acima. Copie a Project URL e a chave pública `anon`/publishable.
3. Na Vercel, importe o repositório do GitHub. O projeto já define `npm run build` e a pasta `build` como saída.
4. Nas variáveis de ambiente da Vercel, defina `GRAFIFLOW_SUPABASE_URL` e `GRAFIFLOW_SUPABASE_ANON_KEY` e publique novamente.
5. Abra o endereço publicado, crie uma conta GrafiFlow e teste cadastro, sincronização entre dois dispositivos e uso offline.

Os dados locais do site antigo pertencem à origem antiga do navegador. Exporte um backup nele e importe no novo GrafiFlow para levar catálogo e orçamentos; a primeira sincronização enviará os dados importados à conta conectada.

## Assinatura Asaas

O GrafiFlow inclui checkout recorrente hospedado pelo Asaas, para cartão de crédito, com 15 dias grátis, três cobranças mensais de R$ 40 e R$ 50 por mês a partir da quarta. O teste começa quando o Asaas cria a assinatura e a primeira cobrança vence 15 dias após a criação do checkout. A quarta mensalidade é atualizada pelo webhook depois da confirmação da terceira cobrança. Eventos são autenticados com token separado da chave de API e processados de forma idempotente.

A integração fica desligada por padrão (`GRAFIFLOW_BILLING_ENABLED=false`). Para preparar o banco, aplique `supabase/migrations/20261031021444_asaas_billing.sql` depois das migrações base listadas acima. Ela estende a tabela de assinaturas e cria tabelas internas protegidas por RLS para registrar cobranças, IDs de assinatura do Asaas e eventos recebidos. A interface mostra o estado da assinatura; ela ainda não bloqueia o uso do app por inadimplência e não oferece cancelamento ou troca de cartão dentro do GrafiFlow. Confirme com o Asaas que a tokenização está habilitada na conta: a atualização do valor de uma assinatura de cartão depende desse recurso.

Configure estas variáveis privadas no projeto Vercel:

- `GRAFIFLOW_SUPABASE_SECRET_KEY`: chave `sb_secret_...` do Supabase, somente no ambiente servidor da Vercel. O código também aceita a chave legada `GRAFIFLOW_SUPABASE_SERVICE_ROLE_KEY`.
- `ASAAS_API_KEY`: chave da API do Asaas para o mesmo ambiente escolhido abaixo.
- `ASAAS_WEBHOOK_AUTH_TOKEN`: token aleatório com pelo menos 32 caracteres, diferente da chave de API.
- `ASAAS_ENVIRONMENT`: `sandbox` para homologação; use `production` somente depois dos testes.
- `GRAFIFLOW_BILLING_ENABLED`: mantenha `false` até concluir banco, chaves e webhook; então publique como `true`.
- `GRAFIFLOW_APP_URL`: endereço HTTPS do GrafiFlow, por padrão `https://grafiflow.vercel.app`.
- `GRAFIFLOW_ALLOWED_ORIGINS`: opcional, origens HTTPS adicionais separadas por vírgula.

No painel Asaas do mesmo ambiente, cadastre o webhook `https://grafiflow.vercel.app/api/asaas/webhook`, use o mesmo `ASAAS_WEBHOOK_AUTH_TOKEN`, habilite entrega sequencial e selecione `CHECKOUT_CREATED`, `CHECKOUT_PAID`, `CHECKOUT_CANCELED`, `CHECKOUT_EXPIRED`, `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_UPDATED`, `SUBSCRIPTION_INACTIVATED`, `SUBSCRIPTION_DELETED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE`, `PAYMENT_CHARGEBACK_REQUESTED` e `PAYMENT_CHARGEBACK_DISPUTE`. O endpoint responde HTTP 200 depois de gravar o evento e concluir eventual troca de preço. Acompanhe os logs do webhook no painel Asaas: se a atualização de valor falhar, a integração responde erro para o Asaas reenviar o evento.

Valide o fluxo completo no Sandbox antes de ativar `production`: criar uma conta de teste, iniciar o checkout, confirmar a assinatura, receber eventos de pagamento e verificar o registro em `workspace_subscriptions`. O retorno visual do checkout não confirma pagamento; o estado só muda por webhook. Checkout recorrente neste fluxo aceita cartão; Pix e boleto recorrentes não estão incluídos.

## Desenvolvimento local

```sh
npm run build
npm run preview
```

Para testar sincronização, defina as duas variáveis de ambiente antes do build. Para testar somente o cálculo/offline, elas podem ficar vazias.
