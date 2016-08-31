FROM node:0.12

# Volumize the NPM package cache.
VOLUME ["/root/.npm_lazy"]

# Server is listening on 0.0.0.0:8080, by default.
EXPOSE 8080

ADD /lib /lib
ADD /index.js /index.js
ADD /package.json /package.json

RUN npm install

# Default server arguments.
CMD ["--show-config"]

# Start the server on entry.
ENTRYPOINT ["node", "index.js"]
