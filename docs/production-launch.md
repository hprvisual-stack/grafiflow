# Estado do beta e checklist de lançamento do Metriflux

Atualizado em 22/11/2026. Este documento separa o que foi verificado no site, o que está implementado no código e o que ainda depende de configuração ou de uma decisão externa.

## Estado atual sem custo

- `https://metriflux.com.br` responde HTTP 200, com título “Metriflux — orçamento gráfico”. O HTML servido usa o pacote publicado `20261122-metriflux-plan-pricing`; ícones, manifesto e worker do PWA também respondem HTTP 200.
- `https://metriflux.com.br/api/config` informa uma configuração Supabase presente e retorna `billingEnabled=false` e `billingCheckoutEnabled=false`. Não há checkout ou cobrança ativa no site.
- O beta atual não aplica trial cronometrado nem bloqueio de assinatura. A conta pode usar o aplicativo sem pagamento enquanto a flag continuar desligada.
- Uma consulta SQL que você mostrou anteriormente indicava `enforcement_enabled=true` no banco. Se esse valor ainda estiver ativo, contas sem trial ou isenção podem continuar bloqueadas para sincronização, mesmo com a cobrança desligada na Vercel. O painel Supabase não está autenticado neste ambiente para eu confirmar ou alterar esse valor.
- O botão para salvar materiais do cálculo e a biblioteca de medidas de vidro estão no código publicado. A biblioteca continua sem dados pré-carregados; cada medida precisa ser cadastrada com origem e direito de uso.
- A marca Metriflux foi padronizada no HTML, no manifesto, nos ativos do PWA, no nome dos backups exportados, nos metadados do pacote e na tela de Actions do GitHub. O ID do PWA e chaves/RPCs Supabase com prefixo `grafiflow` foram mantidos para preservar instalações, sessões, dados e compatibilidade com o banco existente.
- Em 22/11/2026, os dois repositórios (`hprvisual-stack/grafiflow` e `vicktordarosa07-source/grafiflow`) foram atualizados para o mesmo commit `7621b10`. `metriflux.com.br` e `www.metriflux.com.br` servem o pacote com os novos preços e o PWA atualizado. A API privada da Vercel não permite consultar o registro interno do deployment nesta sessão; a confirmação foi feita pelo conteúdo público servido.
- A integração Vercel disponível nesta sessão não lista o projeto, então não pude consultar o painel privado. A confirmação de produção foi feita por respostas HTTP do domínio e de seus ativos públicos.

Este modo é adequado para testes fechados e uso interno sem custo adicional. A Vercel Hobby restringe o serviço a uso pessoal e não comercial; manter o plano gratuito significa adiar venda e divulgação comercial. Consulte [Vercel Hobby](https://vercel.com/docs/plans/hobby) e os [termos da Vercel](https://vercel.com/legal/terms).

## Planos implementados no código; migração e homologação pendentes

| Plano | Mensal nos 3 primeiros meses | Mensal a partir do 4º | Anual à vista |
| --- | ---: | ---: | ---: |
| Individual | R$ 50,00 | R$ 75,00 | R$ 500,00 |
| Equipe até 4 PINs (inclui ADM) | R$ 100,00 | R$ 130,00 | R$ 1.000,00 |
| Equipe 5+ PINs, sem limite | R$ 150,00 | R$ 200,00 | R$ 2.000,00 |

Todos os seis planos preveem trial de 15 dias. O app, as APIs Asaas e as migrações versionadas agora implementam os preços e os limites de equipe. O catálogo ainda precisa ser aplicado e verificado no Supabase; o checkout segue desligado em produção. A conta Vercel Hobby exige adiar vendas até mudar para uma hospedagem que permita uso comercial.

## Pendências para abrir cadastro externo

- [ ] **E-mail de confirmação e recuperação:** confirmar o estado de Auth no projeto Supabase. O SMTP padrão da Supabase só envia para membros da equipe do projeto e limita o envio; para usuários externos é necessário configurar um SMTP próprio e testar confirmação e redefinição de senha. O domínio do site já está ativo, mas os registros de e-mail (SPF/DKIM/DMARC) e as credenciais SMTP não foram verificados. A documentação da Supabase descreve as limitações do [SMTP padrão](https://supabase.com/docs/guides/auth/auth-smtp).
- [ ] **Limite de cinco senhas erradas:** o hook `Password Verification Attempt`, usado para aplicar exatamente esse comportamento, está disponível apenas em planos Supabase Teams e Enterprise. No Free não se deve anunciar esse limite como ativo. Fonte: [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks).
- [ ] **Aplicar catálogo Supabase:** verificar a migração de equipe `20261106000000_team_operations_finance.sql`; depois aplicar `20261117235201_metriflux_plan_catalog_and_team_limits.sql` e `20261122150000_metriflux_current_plan_prices.sql`, e confirmar seis planos, valores, trial de 15 dias e limites 4/5+ no banco correto.
- [ ] **Asaas de produção:** confirmar que existe conta de produção liberada, cadastrar chave de produção e token exclusivo do webhook diretamente nos painéis, instalar endpoint `https://metriflux.com.br/api/asaas/webhook` e testar pagamento, atraso, cancelamento, estorno e reentrega de eventos. Não reutilizar chave/token Sandbox em produção.
- [ ] **Termos e privacidade:** completar os campos pendentes com razão social/responsável, contato, finalidade e retenção de dados, cancelamento, exclusão/exportação e condições de cobrança. Os dados legais precisam vir do proprietário e devem ser revisados antes de venda.
- [ ] **Backups e continuidade:** criar e testar uma exportação/restauração do banco e dos arquivos. O Supabase Free não oferece backup diário para download e pode pausar projetos inativos. Consulte [backups](https://supabase.com/docs/guides/platform/backups) e [limites do Free](https://supabase.com/docs/guides/platform/going-into-prod#understand-your-project).
- [ ] **Sincronização de repositórios:** dar permissão de escrita da identidade GitHub usada no ambiente ao repositório `hprvisual-stack/grafiflow` ou configurar um token de espelhamento de escopo mínimo. Até então, os dois `main` não estão iguais.
- [ ] **Homologação autenticada:** testar cadastro, confirmação, login em dois dispositivos, recuperação de senha, rascunho, gravação final, catálogo, sincronização offline/online, orçamento de equipe, exportação e restauração. Não use dados de clientes reais nos testes.
- [ ] **Uso comercial da hospedagem:** antes de cobrar assinantes, migrar para hospedagem que permita uso comercial ou para um plano compatível. A Vercel Hobby não pode hospedar o SaaS vendido.
- [ ] **Marca:** consultar disponibilidade de “Metriflux” no INPI e nomes/domínios similares antes de investir em divulgação. Consulte o [buscador do INPI](https://servicos.busca.inpi.gov.br/marcas/).

## Ações seguras para manter o beta gratuito

1. Mantenha `GRAFIFLOW_BILLING_ENABLED=false` em Production e confirme periodicamente `/api/config`.
2. No SQL Editor do projeto `ytlcxazmktomawdpssgl`, execute `supabase/diagnostics/free_beta_disable_billing_enforcement.sql` e confirme que o resultado é `false`. O script não desativa RLS nem as regras de pertencimento ao workspace.
3. Use o site para testes internos, sem cobrar nem anunciar assinatura.
4. Não altere o plano da Vercel ou Supabase enquanto o objetivo for custo zero.
5. Faça exportações manuais antes de testes que possam alterar dados importantes.
6. Habilite cadastro externo somente depois de configurar e testar o envio de e-mail.

## Referência para a futura configuração

O endereço canônico do app é `https://metriflux.com.br`; o webhook Asaas futuro deve apontar para `https://metriflux.com.br/api/asaas/webhook`. Valores secretos devem ser inseridos apenas nos painéis apropriados, nunca no repositório, em tickets ou nesta conversa.

Depois de implementar e homologar o novo catálogo de planos, atualizar as variáveis de ambiente da Vercel exige um novo deployment. A URL de retorno do Asaas não comprova pagamento: o acesso só pode ser atualizado após validar o evento financeiro recebido pelo webhook.
