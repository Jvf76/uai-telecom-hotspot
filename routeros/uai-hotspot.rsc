# UAI Telecom Hotspot - RouterOS
# Ajuste PORTAL_IP para o IP do PC onde o Node vai rodar.
# Ajuste IP_DO_PORTAL para o IP do PC/VM onde o Node vai rodar.

:local PORTAL_IP "IP_DO_PORTAL"
:local PORTAL_URL "http://IP_DO_PORTAL:3000"

/interface bridge
add name=bridge-hotspot comment="UAI Telecom Hotspot LAN"

/interface bridge port
add bridge=bridge-hotspot interface=ether2
add bridge=bridge-hotspot interface=ether3
add bridge=bridge-hotspot interface=ether4
add bridge=bridge-hotspot interface=ether5
add bridge=bridge-hotspot interface=ether6
add bridge=bridge-hotspot interface=ether7
add bridge=bridge-hotspot interface=ether8
add bridge=bridge-hotspot interface=ether9
add bridge=bridge-hotspot interface=ether10

/ip dhcp-client
add interface=ether1 disabled=no comment="WAN recebe IP do roteador principal"

/ip address
add address=10.10.10.1/21 interface=bridge-hotspot comment="Gateway hotspot UAI"

/ip pool
add name=pool-hotspot-uai ranges=10.10.8.10-10.10.9.254,10.10.10.2-10.10.15.254

/ip dhcp-server
add name=dhcp-hotspot-uai interface=bridge-hotspot address-pool=pool-hotspot-uai lease-time=1h disabled=no
set dhcp-hotspot-uai lease-script=":if (\$leaseBound = 1) do={ /ip hotspot ip-binding remove [find where mac-address=\$leaseActMAC and comment~\"uai-hotspot janela instagram\"] }"

# Remove liberacoes temporarias antigas que usavam ip-binding para o Instagram.
/ip hotspot ip-binding
remove [find where comment~"uai-hotspot janela instagram"]
remove [find where comment="uai-hotspot instagram declarado"]

/ip dhcp-server network
add address=10.10.8.0/21 gateway=10.10.10.1 dns-server=1.1.1.1,8.8.8.8 comment="Rede clientes hotspot UAI"

/ip firewall nat
add chain=srcnat out-interface=ether1 action=masquerade comment="NAT hotspot UAI para WAN ether1"

/ip hotspot profile
add name=profile-uai hotspot-address=10.10.10.1 dns-name=login.uai.local html-directory=hotspot login-by=http-pap,http-chap use-radius=no

/ip hotspot
add name=hotspot-uai interface=bridge-hotspot address-pool=pool-hotspot-uai profile=profile-uai disabled=no

# Libera acesso ao portal Node no PC antes da autenticacao.
/ip hotspot walled-garden ip
add action=accept dst-address=$PORTAL_IP comment="Portal UAI Node"

# Libera dominios usados pelo Instagram antes da autenticacao.
# A Meta muda dominios/CDNs com frequencia; mantenha esta lista revisada em campo.
/ip hotspot walled-garden
add dst-host=*.instagram.com comment="Instagram UAI"
add dst-host=instagram.com comment="Instagram UAI"
add dst-host=*.cdninstagram.com comment="Instagram CDN"
add dst-host=cdninstagram.com comment="Instagram CDN"
add dst-host=*.facebook.com comment="Login/recursos Meta"
add dst-host=facebook.com comment="Login/recursos Meta"
add dst-host=*.fbcdn.net comment="CDN Meta"
add dst-host=fbcdn.net comment="CDN Meta"

# Habilita REST via HTTP para a aplicacao liberar IP/MAC.
# Para producao, prefira www-ssl com certificado e senha no usuario.
/ip service
set www disabled=no

# Depois de importar este script, substitua o arquivo hotspot/login.html pelo arquivo
# routeros/login.html deste projeto, ajustando PORTAL_URL se necessario.
