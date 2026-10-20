#!/bin/sh
set -eu
rm -f /guard/ready
iptables -P OUTPUT DROP
iptables -F OUTPUT
iptables -A OUTPUT -d 172.30.85.2 -p tcp --dport 3128 -j ACCEPT
ip6tables -P OUTPUT DROP
ip6tables -F OUTPUT
# Docker embedded DNS installs NAT rules: remove them in this dedicated namespace.
iptables -t nat -F OUTPUT
ip6tables -t nat -F OUTPUT
printf firewall-v1 > /guard/ready
chmod 444 /guard/ready
exec sleep infinity
