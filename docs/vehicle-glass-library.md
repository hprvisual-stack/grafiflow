# Biblioteca de vidros automotivos

## Escopo desta primeira versão

- Uma ficha por peça de vidro, organizada por marca, modelo, geração, intervalo de anos, carroceria e versão.
- Largura e altura máximas em milímetros como referência dimensional.
- Origem, licença, confirmação de direitos, estado de revisão e conta/equipe responsável registrados no Supabase.
- Medições da empresa ficam restritas ao espaço da empresa. Sugestões para a biblioteca geral começam pendentes e só são publicadas por uma conta Metriflux DEV.
- Não há dados de veículos pré-carregados nesta entrega. Nenhuma medida foi estimada ou copiada de catálogos comerciais.

## Limite técnico

Largura × altura descreve apenas o retângulo envolvente do vidro. Não é o contorno real nem um arquivo de corte para plotter. A tela deixa essa limitação visível para evitar que a referência seja confundida com molde de película.

## Fontes aceitas

- `own_measurement`: medição própria ou autorizada.
- `licensed`: fonte licenciada, com nome da licença.
- `open_license`: fonte aberta, com licença indicada.
- `public_reference`: referência pública identificada por URL HTTPS.

Cada envio exige confirmação de que os dados foram medidos pelo usuário ou podem ser usados legalmente. O Metriflux não deve importar, extrair ou republicar dados de outro software sem autorização.

## Aplicação no Supabase

A migração `20261120205154_vehicle_glass_library.sql` cria as tabelas e funções. Ela ainda precisa ser aplicada no projeto Supabase de destino antes de a tela poder ler e gravar medições. O banco exige login e associação ao workspace; em contas de equipe, os RPCs também validam a sessão do PIN.
