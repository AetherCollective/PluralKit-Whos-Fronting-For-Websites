What you need:
  - A server
  - Docker 
  - Nginx
  - A website (to display who's fronting)
  - Your API Key
  - Your System ID

Configure the `docker-compose.yml` by updating build to point to where `pk-relay.js` is stored, and set your `API_KEY` & `SYSTEM_ID`. After that, you can build and run it.

Configure `nginx.conf` by updating `proxy_pass` to your Relay IP

Now copy the `<script>` from `website.html` and put it someone on your website. At the top of `<script>`, set your Relay IP and specific an `elementID` to replace.

Respects visibility setting, will only show public members.

Made by the Aether Collective 
Discord: @aethercollective
