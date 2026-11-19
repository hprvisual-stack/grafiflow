# Metriflux

Aplicativo web progressivo para orçamento e aproveitamento de bobinas e chapas. A aplicação continua funcionando offline no Windows e no Android; os dados locais são mantidos no IndexedDB e podem ser exportados em backup.

## Stack

- **GitHub:** repositório principal e cópia sincronizada do código.
- **Vercel:** publicação do app estático/PWA.
- **Supabase:** autenticação por e-mail, espaços de trabalho, sincronização entre dispositivos, RLS e estrutura inicial de assinaturas.

O núcleo de cálculo não depende de conexão. A nuvem é uma camada opcional: quando o usuário entra e há internet, o Metriflux sincroniza rascunho, catálogo e orçamentos; alterações offline entram em uma fila local e são enviadas ao reconectar.

## Publicação na Vercel

1. Configure no projeto Vercel as variáveis `GRAFIFLOW_SUPABASE_URL` e `GRAFIFLOW_SUPABASE_ANON_KEY`. O app as lê em runtime por `/api/config`; a chave pública e a flag de cobrança são as únicas configurações enviadas ao navegador.
2. Use `npm run build` como comando de build e `build` como diretório de saída (já definido em `vercel.json`).
3. A chave `anon` do Supabase é uma chave pública para uso no navegador. **Nunca configure `service_role` no front-end ou na Vercel como variável exposta ao cliente.** As regras RLS protegem os dados.

Sem as duas variáveis, o app continua funcionando offline, mas a conta e a sincronização em nuvem ficam desativadas.

## Supabase

Aplique, nesta ordem, `supabase/migrations/202610030001_grafiflow_core.sql`, `supabase/migrations/202610040001_account_profiles.sql`, `supabase/migrations/202610060001_sync_conflict_versions.sql`, `supabase/migrations/202610070001_incremental_sync_catalog_types.sql` e `supabase/migrations/20261029085324_customer_records.sql` no projeto Supabase. A primeira migração cria perfis, espaços de trabalho, membros, registros sincronizados, políticas RLS e uma tabela neutra de assinaturas; a segunda adiciona os dados de cadastro e preenchimento de orçamento ao perfil privado do titular; a terceira usa versões geradas pelo servidor para rejeitar gravações baseadas em uma versão remota antiga; a quarta cria um cursor incremental seguro para a sincronização, separa acabamentos, insumos, mão de obra e extras em tipos próprios e migra os itens existentes; a quinta cria os registros de clientes. Sem a quarta migração, o app mantém compatibilidade com o formato antigo e continua fazendo a carga completa dos registros.

O PWA busca apenas registros alterados desde o último cursor do espaço de trabalho. A carga inicial continua trazendo todos os registros, em páginas; exclusões permanecem como marcadores para que também sejam propagadas. O cursor usa sequência gerada pelo banco e gravações do mesmo espaço são serializadas para não pular alterações concorrentes.

Use `https://metriflux.com.br` como Site URL e permita essa origem nas Redirect URLs. Em Auth > Email Templates, use `{{ .ConfirmationURL }}` como destino de um botão “Confirmar cadastro” no modelo Confirm Signup e um botão “Redefinir senha” no modelo Reset Password. O SMTP padrão do Supabase só entrega mensagens a endereços da equipe do projeto e tem limite baixo; confirmação e recuperação por e-mail para testadores externos exigem SMTP próprio.

Antes de abrir cadastros ao público, configure SMTP transacional próprio, confirme os links de confirmação e recuperação no domínio publicado e mantenha templates sem rastreamento de links que possa alterar as URLs do Supabase. O projeto Free não oferece backup diário para download e pode ser pausado por inatividade; use um plano com backup automático ou configure exportações regulares fora do Supabase.

Ao informar um CEP completo em Minha conta, o Metriflux consulta o ViaCEP e sugere rua, bairro, cidade e UF. Só o CEP é enviado ao serviço; número e complemento continuam sendo preenchidos pelo usuário, e os demais campos podem ser editados.

## Configuração inicial das plataformas

1. Mantenha o repositório principal e a cópia do Git sincronizados, preservando `dist/`, `scripts/` e `supabase/` na raiz.
2. No Supabase, crie um projeto e execute o SQL da migração acima. Copie a Project URL e a chave pública `anon`/publishable.
3. Na Vercel, importe o repositório do GitHub. O projeto já define `npm run build` e a pasta `build` como saída.
4. Nas variáveis de ambiente da Vercel, defina `GRAFIFLOW_SUPABASE_URL` e `GRAFIFLOW_SUPABASE_ANON_KEY` e publique novamente. A rota `/api/config` entrega essas configurações públicas em runtime.
5. Abra `https://metriflux.com.br`, crie uma conta e teste cadastro, sincronização entre dois dispositivos e uso offline.

Os dados locais do site antigo pertencem à origem antiga do navegador. Exporte um backup nele e importe no Metriflux para levar catálogo e orçamentos; a primeira sincronização enviará os dados importados à conta conectada.

## Cobrança e planos comerciais

O Metriflux está em beta gratuito: em produção, `GRAFIFLOW_BILLING_ENABLED=false` e o checkout está desligado. Enquanto essa flag permanecer falsa, não há trial cronometrado nem cobrança pelo app; o uso não deve ser anunciado como venda ou como assinatura ativa. Para liberar sincronização gratuita a todos os workspaces durante o beta, o banco também precisa estar com `private.grafiflow_billing_settings.enforcement_enabled=false`; use o script `supabase/diagnostics/free_beta_disable_billing_enforcement.sql` no SQL Editor e confirme o resultado. Isso não desativa as políticas RLS de isolamento dos dados.

Tabela comercial definida para uma etapa futura, ainda não habilitada no produto:

| Plano | Mensal: 3 primeiros meses | Mensal: depois | Anual à vista |
| --- | ---: | ---: | ---: |
| Individual | R$ 35,00/mês | R$ 50,00/mês | R$ 500,00 |
| Equipe até 4 pessoas | R$ 75,00/mês | R$ 100,00/mês | R$ 1.000,00 |
| Equipe com 5+ pessoas | R$ 150,00/mês | R$ 200,00/mês | R$ 2.000,00 |

Os planos comerciais preveem 15 dias de teste. A versão de cobrança atualmente no código ainda implementa apenas os tipos antigos individual mensal/anual, usa anual de R$ 450,00 e informa `team_checkout_available=false`. Não habilite cobrança antes de migrar preços e tipos de plano no app, API, funções do banco e webhooks, e homologar o ciclo completo em um Sandbox isolado. O checkout ativo poderia cobrar valores antigos.

Depois das migrações base, aplique nesta ordem: `20261031021444_asaas_billing.sql`, `20261031120000_grafiflow_subscriptions_entitlements.sql`, `20261102000000_move_unused_legacy_workspaces_to_trial.sql`, `20261103000000_billing_payment_links_and_login_lockout.sql` e `20261103010000_permanent_free_accounts.sql`. A migração de entitlements cria o histórico financeiro, implementa trial único, carência, leitura do status e proteção de gravações por RLS/RPC. A migração de contas legadas **não reclassifica usuários automaticamente**: cada conta deve ser revisada com `supabase/diagnostics/legacy_trial_preflight.sql`, aprovada com evidência e só então processada por `supabase/diagnostics/legacy_trial_apply_approved.sql`. Contas com trial, pagamento ou checkout são excluídas; direitos legados concedidos manualmente ou situações ambíguas não devem ser aprovados. A migração de acesso gratuito permanente usa uma lista privada por ID de usuário; não inclua e-mails ou IDs reais no repositório.

Use um projeto Supabase separado para Preview e homologação. O flag `private.grafiflow_billing_settings.enforcement_enabled` é global ao projeto e afeta qualquer deployment que use esse banco; não use Preview para testes de cobrança quando ele compartilhar o banco de produção. No banco de produção, habilite o enforcement somente depois de revisar os espaços legados, confirmar a lista privada de isenções e publicar a versão compatível do app. A ativação é feita pelo SQL Editor:

```sql
update private.grafiflow_billing_settings
set enforcement_enabled = true, updated_at = now()
where singleton = true;
```

Não habilite `GRAFIFLOW_BILLING_ENABLED` enquanto a implementação não suportar os seis produtos e preços comerciais desta tabela. Depois dessa atualização, faça homologação em Preview isolado, com projetos Supabase e Asaas Sandbox próprios. Nunca aponte o banco de produção para o Preview nem deixe checkout Sandbox visível a clientes. Alterações de variáveis de ambiente da Vercel exigem um novo deployment.

Configure estas variáveis privadas no projeto Vercel somente durante a homologação futura; no beta gratuito, mantenha cobrança desligada:

- `GRAFIFLOW_SUPABASE_SECRET_KEY`: chave `sb_secret_...` do Supabase, somente no ambiente servidor da Vercel. O código também aceita a chave legada `GRAFIFLOW_SUPABASE_SERVICE_ROLE_KEY`.
- `ASAAS_API_KEY`: chave da API do Asaas para o mesmo ambiente escolhido abaixo.
- `ASAAS_WEBHOOK_AUTH_TOKEN`: token aleatório com pelo menos 32 caracteres, diferente da chave de API.
- `ASAAS_ENVIRONMENT`: `sandbox` para homologação; use `production` somente depois dos testes.
- `GRAFIFLOW_BILLING_ENABLED`: mantenha `false` durante o beta gratuito. A implementação atual não está alinhada aos planos comerciais acima.
- `GRAFIFLOW_APP_URL`: endereço HTTPS do Metriflux, `https://metriflux.com.br`.
- `GRAFIFLOW_ALLOWED_ORIGINS`: opcional, origens HTTPS adicionais separadas por vírgula.

No futuro, o webhook de produção deverá usar `https://metriflux.com.br/api/asaas/webhook`. Não configure nem habilite esse fluxo até a implementação suportar a tabela de planos acima e até os testes de Sandbox e a conta Asaas de produção estarem prontos.

O código legado cria o plano mensal como Link de Pagamento recorrente do Asaas e o anual como pagamento único. Esse fluxo não corresponde aos seis produtos comerciais solicitados e está pausado. Após a implementação dos planos, confirme meios de pagamento e mudanças de preço com a [documentação oficial de Links de Pagamento do Asaas](https://docs.asaas.com/docs/creating-a-payment-link) e faça homologação no Sandbox antes de produção.

A migração `20261103000000_billing_payment_links_and_login_lockout.sql` também cria o hook de tentativa de senha: bloqueia após cinco senhas inválidas, direciona a interface para recuperação e remove o bloqueio depois da troca de senha. **O hook não fica ativo só por aplicar SQL.** A disponibilidade depende do plano Supabase atual; confirme em Authentication > Hooks antes de anunciar o limite de cinco tentativas. Em plano compatível, selecione Password Verification Attempt e `pg-functions://postgres/public/grafiflow_password_verification_attempt`. A tabela de tentativas não é acessível por usuários do app. Consulte [Auth Hooks do Supabase](https://supabase.com/docs/guides/auth/auth-hooks) antes de ativar.

Valide no Sandbox os seis produtos, o trial, os limites de colaboradores, os meios oferecidos pela conta, confirmação via webhook, períodos, histórico, falha/estorno e carência. Não use conta isenta nem a conta principal para consumir trial. O retorno visual do checkout não comprova pagamento. Consulte o [runbook de lançamento](docs/production-launch.md) antes de abrir vendas.

## Desenvolvimento local

```sh
npm run build
npm run preview
```

Para testar sincronização, defina as duas variáveis de ambiente antes do build. Para testar somente o cálculo/offline, elas podem ficar vazias.
