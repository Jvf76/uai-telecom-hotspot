# UAI Telecom Hotspot - RouterOS
# Ajuste PORTAL_IP para o IP do PC onde o Node vai rodar.
# Neste ambiente o PC esta no lado WAN/principal em 192.168.30.100.

:local PORTAL_IP "192.168.30.100"
:local PORTAL_URL "http://192.168.30.100:3000"

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
add address=10.10.10.1/24 interface=bridge-hotspot comment="Gateway hotspot UAI"

/ip pool
add name=pool-hotspot-uai ranges=10.10.10.20-10.10.10.254

/ip dhcp-server
add name=dhcp-hotspot-uai interface=bridge-hotspot address-pool=pool-hotspot-uai lease-time=1h disabled=no

/ip dhcp-server network
add address=10.10.10.0/24 gateway=10.10.10.1 dns-server=1.1.1.1,8.8.8.8 comment="Rede clientes hotspot UAI"

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
