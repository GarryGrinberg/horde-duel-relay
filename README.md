# Horde Duel relay

Pairs players by a 5-digit room code and passes their inputs along. The match itself runs on the players' devices
(lockstep), so the server only forwards small messages. Plain Node + `ws`, no database, no secrets.

Run locally: `npm install && node server.js` (port 8787, or `PORT`).
Deploy on Render: New → Blueprint, pick this repo (uses `render.yaml`: a free web service named `horde-duel-relay`).
The free plan sleeps after 15 minutes without traffic; the game wakes it when you open Play a friend.
