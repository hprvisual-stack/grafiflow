# Estado do beta e checklist de lançamento do Metriflux

Atualizado em 19/11/2026. Este documento separa o que foi verificado no site, o que está implementado no código e o que ainda depende de configuração ou de uma decisão externa.

## Estado atual sem custo

- `https://metriflux.com.br` resolve para a Vercel e responde HTTP 200.
- `https://metriflux.com.br/api/config` informa o projeto Supabase `ytlcxazmktomawdpssgl` e retorna `billingEnabled=false` e `billingCheckoutEnabled=false`. Não há checkout ou cobrança ativa no site.
- O beta atual não aplica trial cronometrado nem bloqueio de assinatura. A conta pode usar o aplicativo sem pagamento enquanto a flag continuar desligada.
- O commit de produção verificado anteriormente contém o botão para salvar materiais do cálculo na galeria. Uma validação de navegador autenticada e de sincronização com dados reais não foi feita nesta checagem.
- O CLI da Vercel não encontrou vínculo local de projeto neste checkout (`link_required`), e o Supabase CLI não está instalado/autenticado aqui. Portanto, não foi possível consultar ou alterar as configurações privadas dos painéis.
- A branch principal da cópia pessoal está no commit `b5efbe3`; a principal do repositório `hprvisual-stack/grafiflow` consultada está em `54aeb72`. Os repositórios estão divergentes. A cópia pessoal é a que contém as atualizações mais recentes deste checkout.

Este modo é adequado para testes fechados e uso interno sem custo adicional. A Vercel Hobby restringe o serviço a uso pessoal e não comercial; manter o plano gratuito significa adiar venda e divulgação comercial. Consulte [Vercel Hobby](https://vercel.com/docs/plans/hobby) e os [termos da Vercel](https://vercel.com/legal/terms).

## Planos definidos, mas ainda não implementados no checkout

| Plano | Mensal nos 3 primeiros meses | Mensal a partir do 4º | Anual à vista |
| --- | ---: | ---: | ---: |
| Individual | R$ 35,00 | R$ 50,00 | R$ 500,00 |
| Equipe até 4 pessoas | R$ 75,00 | R$ 100,00 | R$ 1.000,00 |
| Equipe com 5+ pessoas | R$ 150,00 | R$ 200,00 | R$ 2.000,00 |

Os planos preveem trial de 15 dias. A versão de cobrança que está no repositório ainda suporta apenas plano mensal/anual sem seleção comercial completa de equipe, anuncia anual de R$ 450,00 e retorna `team_checkout_available=false`. Por isso, não habilite `GRAFIFLOW_BILLING_ENABLED`: se o checkout legado fosse aberto, mostraria condições divergentes das definidas para o Metriflux.

## Pendências para abrir cadastro externo

- [ ] **E-mail de confirmação e recuperação:** confirmar o estado de Auth no projeto Supabase. O SMTP padrão da Supabase só envia para membros da equipe do projeto e limita o envio; para usuários externos é necessário configurar um SMTP próprio e testar confirmação e redefinição de senha. O domínio do site já está ativo, mas os registros de e-mail (SPF/DKIM/DMARC) e as credenciais SMTP não foram verificados. A documentação da Supabase descreve as limitações do [SMTP padrão](https://supabase.com/docs/guides/auth/auth-smtp).
- [ ] **Limite de cinco senhas erradas:** o hook `Password Verification Attempt`, usado para aplicar exatamente esse comportamento, está disponível apenas em planos Supabase Teams e Enterprise. No Free não se deve anunciar esse limite como ativo. Fonte: [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks).
- [ ] **Implementar os seis preços/tipos de plano:** atualizar a seleção de plano, limites de membros, APIs, RPCs/migrações Supabase, estado da assinatura, Asaas e webhooks para suportar individual, equipe até 4 e equipe 5+, mensal e anual. Depois, homologar em projeto Supabase e conta Asaas Sandbox isolados.
- [ ] **Asaas de produção:** confirmar que existe conta de produção liberada, cadastrar chave de produção e token exclusivo do webhook diretamente nos painéis, instalar endpoint `https://metriflux.com.br/api/asaas/webhook` e testar pagamento, atraso, cancelamento, estorno e reentrega de eventos. Não reutilizar chave/token Sandbox em produção.
- [ ] **Termos e privacidade:** completar os campos pendentes com razão social/responsável, contato, finalidade e retenção de dados, cancelamento, exclusão/exportação e condições de cobrança. Os dados legais precisam vir do proprietário e devem ser revisados antes de venda.
- [ ] **Backups e continuidade:** criar e testar uma exportação/restauração do banco e dos arquivos. O Supabase Free não oferece backup diário para download e pode pausar projetos inativos. Consulte [backups](https://supabase.com/docs/guides/platform/backups) e [limites do Free](https://supabase.com/docs/guides/platform/going-into-prod#understand-your-project).
- [ ] **Sincronização de repositórios:** dar permissão de escrita da identidade GitHub usada no ambiente ao repositório `hprvisual-stack/grafiflow` ou configurar um token de espelhamento de escopo mínimo. Até então, os dois `main` não estão iguais.
- [ ] **Homologação autenticada:** testar cadastro, confirmação, login em dois dispositivos, recuperação de senha, rascunho, gravação final, catálogo, sincronização offline/online, orçamento de equipe, exportação e restauração. Não use dados de clientes reais nos testes.
- [ ] **Uso comercial da hospedagem:** antes de cobrar assinantes, migrar para hospedagem que permita uso comercial ou para um plano compatível. A Vercel Hobby não pode hospedar o SaaS vendido.
- [ ] **Marca:** consultar disponibilidade de “Metriflux” no INPI e nomes/domínios similares antes de investir em divulgação. Consulte o [buscador do INPI](https://servicos.busca.inpi.gov.br/marcas/).

## Ações seguras para manter o beta gratuito

1. Mantenha `GRAFIFLOW_BILLING_ENABLED=false` em Production e confirme periodicamente `/api/config`.
2. Use o site para testes internos, sem cobrar nem anunciar assinatura.
3. Não altere o plano da Vercel ou Supabase enquanto o objetivo for custo zero.
4. Faça exportações manuais antes de testes que possam alterar dados importantes.
5. Habilite cadastro externo somente depois de configurar e testar o envio de e-mail.

## Referência para a futura configuração

O endereço canônico do app é `https://metriflux.com.br`; o webhook Asaas futuro deve apontar para `https://metriflux.com.br/api/asaas/webhook`. Valores secretos devem ser inseridos apenas nos painéis apropriados, nunca no repositório, em tickets ou nesta conversa.

Depois de implementar e homologar o novo catálogo de planos, atualizar as variáveis de ambiente da Vercel exige um novo deployment. A URL de retorno do Asaas não comprova pagamento: o acesso só pode ser atualizado após validar o evento financeiro recebido pelo webhook.
