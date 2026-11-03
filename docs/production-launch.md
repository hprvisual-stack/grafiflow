# Runbook de lançamento do MetriFlow

Use este checklist para passar da homologação para cobrança real. A configuração do Sandbox e o deploy do app, sozinhos, não significam que o fluxo de cobrança em produção foi homologado.

## Resultado da checagem em 03/11/2026

- `npm test`: 75 aprovados, 0 falhas. `npm run build`: aprovado. `npm audit --omit=dev`: 0 vulnerabilidades.
- Site de produção e `/api/config`: HTTP 200; projeto Supabase correto. `billingEnabled=true`, mas `billingCheckoutEnabled=false`; o checkout está indisponível em produção e nenhum pagamento real foi feito nesta checagem.
- Auth do Supabase: cadastro por e-mail habilitado, **Confirm email desligado** e **SMTP personalizado desligado**. O servidor padrão do Supabase só envia para membros da equipe e limita o envio a 2 mensagens por hora; não ligar confirmação até configurar e testar SMTP próprio.
- Vercel: a equipe do projeto continua no Hobby. As variáveis `ASAAS_ENVIRONMENT`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_AUTH_TOKEN` estão cadastradas em Production, mas seus valores são secretos e não foram lidos. O runtime continua recusando checkout, então ainda é necessário garantir que chave e webhook sejam da conta de produção e definir `ASAAS_ENVIRONMENT=production`.
- Não foi possível executar uma jornada de navegador autenticada ou um pagamento real: não foram criados usuários de teste nem iniciada cobrança na conta de produção. Os testes de cobrança automatizados usam respostas simuladas.
- A marca MetriFlow e os arquivos do PWA foram publicados e verificados por HTTP em produção. A jornada visual autenticada e a atualização dos templates no painel Supabase ainda precisam de confirmação manual.

## Bloqueios antes de abrir venda ao público

- [ ] **Hospedagem comercial:** migrar a Vercel Hobby para um plano que permita uso comercial ou escolher outra hospedagem comercial. A Hobby é restrita a projetos pessoais/não comerciais.
- [ ] **Cópia do GitHub:** o fluxo automático de espelhamento está configurado para ignorar a etapa de cópia quando falta `GRAFIFLOW_LEGACY_MIRROR_TOKEN`. Até cadastrar um token de escopo mínimo como Secret de Actions no repositório principal, publicar cada release manualmente nos dois repositórios e conferir o mesmo SHA em `main`.
- [ ] **Banco, backups e disponibilidade:** o Supabase Free pode pausar projeto por inatividade e não fornece backup automático diário para download. Ativar um plano com backup diário ou configurar e testar exportações externas periódicas do banco e dos arquivos de Storage.
- [ ] **Homologação isolada:** criar um projeto Supabase separado para Preview/testes. O flag `private.grafiflow_billing_settings.enforcement_enabled` e os trials são compartilhados por qualquer deployment que use o mesmo banco.
- [ ] **E-mail de produção:** habilitar Confirm email depois de configurar SMTP transacional próprio no Supabase Auth, confirmar domínio remetente, SPF/DKIM/DMARC, redirects para `https://grafiflow.vercel.app` e testar confirmação de cadastro e recuperação de senha em endereços externos à equipe.
- [ ] **Bloqueio após cinco senhas erradas:** o hook Password Verification Attempt está disponível apenas nos planos Supabase Teams e Enterprise. Como o projeto está no Free, esse bloqueio específico não pode ser ativado nesse plano; não o anuncie como ativo. Para mantê-lo, será necessário migrar para um plano compatível ou aprovar e revisar uma alternativa de autenticação no servidor.
- [ ] **Asaas de produção:** o runtime observado em 03/11/2026 mantém `billingCheckoutEnabled=false`. Usar `ASAAS_ENVIRONMENT=production`, uma chave API e webhook criados na conta de produção do Asaas, publicar novamente e testar o ciclo real de forma controlada. Sandbox e produção são contas e credenciais distintas. Não reutilizar chave Sandbox em produção nem compartilhar chaves em chats ou no Git.
- [ ] **Dados legais e atendimento:** completar os campos `[PENDENTE]` das páginas de termos e privacidade, incluindo responsável, contato, cancelamento, retenção, exclusão/exportação e regras de cobrança. Revisar o texto com orientação jurídica. As páginas estão com `noindex` enquanto incompletas.
- [ ] **Identidade no checkout:** abrir um checkout de homologação e confirmar qual nome comercial/legal o pagador verá. Resolver a apresentação da conta Asaas antes da divulgação.

Para habilitar o espelhamento automático, crie um fine-grained token com acesso somente ao repositório de cópia `vicktordarosa07-source/grafiflow`, permissão **Contents: Read and write**, e cadastre-o como Secret `GRAFIFLOW_LEGACY_MIRROR_TOKEN` em `hprvisual-stack/grafiflow`. Nunca grave o valor no código ou em variáveis expostas ao navegador.

## Homologação no Sandbox

Use somente usuários de teste que não tenham isenção permanente. Não use a conta principal para consumir o trial.

- [ ] Criar conta, confirmar e-mail, entrar em outro dispositivo e recuperar senha.
- [ ] Iniciar o trial manualmente e confirmar 15 dias, bloqueio após expiração e impossibilidade de reiniciá-lo.
- [ ] Testar plano mensal: R$ 35 nos três primeiros ciclos pagos e R$ 50 a partir do quarto; verificar o valor de cada cobrança no Asaas e no histórico local.
- [ ] Testar plano anual: R$ 450 em pagamento único, sem parcelamento.
- [ ] Confirmar que checkout criado/retorno de sucesso não libera acesso antes do evento financeiro recebido no webhook.
- [ ] Testar pagamento confirmado, pendente, vencido, cancelado e estornado; verificar carência, acesso e histórico.
- [ ] Confirmar que um webhook repetido não gera cobrança ou registro duplicado e que eventos fora de ordem não reabrem acesso indevidamente.
- [ ] Testar cancelamento/alteração de plano e a cobrança antecipada sem criar uma cobrança duplicada.
- [ ] Testar sincronização web/PWA, modo offline, backup/exportação e restauração dos dados.

## Configuração Vercel de produção

Configure os valores privados apenas em **Production**. Configure Preview separadamente e conecte-o somente ao Supabase e Asaas Sandbox de homologação.

O backend e a interface agora recusam combinações cruzadas: Production exige `ASAAS_ENVIRONMENT=production`, enquanto Preview/Development aceitam apenas Sandbox. Se a Vercel não fornecer o contexto do deployment, o checkout é bloqueado por segurança. Isso não substitui a configuração das credenciais e do webhook reais.

- `GRAFIFLOW_SUPABASE_URL`: URL do projeto Supabase de produção.
- `GRAFIFLOW_SUPABASE_ANON_KEY`: chave pública do Supabase; é a única chave Supabase adequada ao navegador.
- `GRAFIFLOW_SUPABASE_SECRET_KEY`: chave secreta apenas no servidor Vercel; nunca exponha no bundle do site.
- `GRAFIFLOW_BILLING_ENABLED=true`: ativa as rotas/configuração de cobrança.
- `ASAAS_ENVIRONMENT=production`: seleciona o endpoint Asaas de produção.
- `ASAAS_API_KEY`: chave API da conta Asaas de produção.
- `ASAAS_WEBHOOK_AUTH_TOKEN`: segredo exclusivo, aleatório, com pelo menos 32 caracteres; deve ser idêntico no Asaas e na Vercel.
- `GRAFIFLOW_APP_URL=https://grafiflow.vercel.app`.

No Asaas de produção, configure o webhook em `https://grafiflow.vercel.app/api/asaas/webhook`, com entrega sequencial e os eventos de Checkout, Subscription e Payment descritos no README. Não misture o webhook de Sandbox com a API de produção.

Depois de alterar variáveis, faça um novo deployment. A URL de sucesso do checkout é apenas um redirecionamento; a liberação de acesso depende da confirmação processada pelo webhook.

## Critério de liberação

Liberar primeiro para um grupo pequeno. Só divulgar publicamente depois de concluir todos os bloqueios, ter um backup restaurável e observar um ciclo completo de checkout e webhook de produção. Registrar quem acompanha pagamentos e quem atende cancelamentos e solicitações de dados.

## Documentação oficial

- [Plano Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Checklist de produção do Supabase](https://supabase.com/docs/guides/deployment/going-into-prod)
- [SMTP próprio no Supabase Auth](https://supabase.com/docs/guides/auth/auth-smtp)
- [Planos compatíveis com Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks)
- [Backups Supabase](https://supabase.com/docs/guides/platform/backups)
- [Sandbox do Asaas](https://docs.asaas.com/docs/sandbox-2)
- [Checkout recorrente e webhooks do Asaas](https://docs.asaas.com/docs/checkout-with-subscription-recurring)
