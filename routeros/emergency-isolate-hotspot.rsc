# UAI Telecom Hotspot - isolamento emergencial
# Use se o hotspot/DHCP estiver afetando a rede principal.
#
# Topologia esperada:
# - ether1: entrada/WAN ligada na rede principal
# - ether2: saida exclusiva para AP/clientes do hotspot
# - ether3..ether10: fora da bridge-hotspot ate confirmar o cabeamento

/interface bridge port
remove [find where bridge=bridge-hotspot and interface=ether1]
remove [find where bridge=bridge-hotspot and interface=ether3]
remove [find where bridge=bridge-hotspot and interface=ether4]
remove [find where bridge=bridge-hotspot and interface=ether5]
remove [find where bridge=bridge-hotspot and interface=ether6]
remove [find where bridge=bridge-hotspot and interface=ether7]
remove [find where bridge=bridge-hotspot and interface=ether8]
remove [find where bridge=bridge-hotspot and interface=ether9]
remove [find where bridge=bridge-hotspot and interface=ether10]

/interface bridge port
:if ([:len [find where bridge=bridge-hotspot and interface=ether2]] = 0) do={ add bridge=bridge-hotspot interface=ether2 }

/ip hotspot ip-binding
remove [find where comment~"uai-hotspot janela instagram"]
remove [find where comment="uai-hotspot instagram declarado"]

/interface bridge port print
/ip hotspot print detail
/ip dhcp-server print detail
/ip hotspot ip-binding print detail
