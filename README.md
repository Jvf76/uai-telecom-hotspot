# UAI Telecom Hotspot

Sistema Node para portal hotspot UAI Telecom com consulta de CPF no IXC e liberação do cliente na MikroTik.

## Como rodar no PC

1. Deixe o PC do portal acessivel pela MikroTik. Neste ambiente ele esta em `192.168.30.100`.
2. Copie `.env.example` para `.env`.
3. Ajuste no `.env` os dados reais do IXC e, quando a RouterOS REST estiver ativa, coloque `MIKROTIK_ENABLED=true`.
4. Rode:

```powershell
npm start
```

O portal abre em `http://192.168.30.100:3000`.

## Fluxo

- Cliente acessa a rede hotspot.
- MikroTik redireciona para o portal Node.
- O usuário informa CPF.
- O portal consulta o IXC.
- Se o cliente estiver ativo, o portal cria um `ip-binding` do tipo `bypassed` na MikroTik.
- Se não estiver ativo, o portal mostra o Instagram da UAI Telecom; após o usuário tocar em `Já segui`, o acesso é liberado.
- Cada tentativa vira um lead local para consulta no painel.

Observação: o Instagram/Meta não fornece uma verificação aberta e confiável para confirmar follow nesse tipo de captive portal. Por isso, o botão `Já segui` registra a confirmação declarada pelo usuário e libera o acesso.

## Configuração MikroTik

A configuração base está em `routeros/uai-hotspot.rsc`:

- `ether1`: WAN recebendo DHCP do roteador principal.
- `ether2` a `ether10`: bridge LAN hotspot.
- Gateway LAN: `10.10.10.1/24`.
- DHCP clientes: `10.10.10.20-10.10.10.254`.
- NAT via `ether1`.
- Hotspot na bridge.
- Walled garden para o portal `10.10.10.2` e domínios do Instagram/Meta.

Depois de importar o script, envie `routeros/login.html` para a pasta `hotspot` da MikroTik para redirecionar o login para o PC.

## Variáveis principais

- `IXC_BASE_URL`: URL base do IXC. Neste projeto: `https://sistema.uaitelecom.com.br/webservice/v1`.
- `IXC_TOKEN`: token da API IXC.
- `IXC_CUSTOMER_ENDPOINT`: por padrão `/cliente`.
- `IXC_ACTIVE_STATUSES`: valores considerados ativos, por padrão `Ativo,A`.
- `MIKROTIK_BASE_URL`: por padrão `http://192.168.30.108/rest`.
- `MIKROTIK_ENABLED`: deixe `false` para testar sem mexer na MikroTik; use `true` em produção.
- `INSTAGRAM_PROFILE_URL`: URL do perfil da UAI Telecom.
- `ADMIN_USER`: usuário do painel.
- `ADMIN_PASSWORD`: senha do painel.

## Painel de leads

Com o servidor rodando, acesse:

```text
http://192.168.30.100:3000/admin
```

Configure o usuário e senha no `.env`:

```text
ADMIN_USER=admin
ADMIN_PASSWORD=coloque_uma_senha_forte
```

Os leads ficam em `data/leads.jsonl` e o painel permite buscar e exportar CSV.
