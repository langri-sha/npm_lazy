#
# Dockerfile for langrisha/npm-lazy
#
# A Docker container to speed up your NPM deploys http://mixu.net/npm_lazy/.
#
# See:
#   npm_lazy project page
#     http://mixu.net/npm_lazy/
#   mixu/npm_lazy repository
#     https://github.com/mixu/npm_lazy/
#   configuration defaults (effectively applied)
#     https://github.com/mixu/npm_lazy/blob/master/config.js
#   docker hub
#     https://registry.hub.docker.com/u/langrisha/npm-lazy/
#   docker source repository
#     https://github.com/langri-sha/npm_lazy/
#

# Based on the much regarded Google Node.js image.
FROM google/nodejs-runtime

# Volumize the NPM package cache.
VOLUME ["/root/.npm_lazy"]

# Server is listening on 0.0.0.0:8080, by default.
EXPOSE 8080

# Arguments effectively passed to `index.js`.
CMD ["--show-config"]
