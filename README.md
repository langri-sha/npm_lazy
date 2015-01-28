[![Stories in Ready](https://badge.waffle.io/langri-sha/npm_lazy.png?label=ready&title=Ready)](https://waffle.io/langri-sha/npm_lazy)
# Docker npm_lazy

Add this Docker container to your orchestration and enjoy near-instantaneous
package dependency resolutions, courtesy of
[mixu's lazy npm cache](http://mixu.net/npm_lazy/)
(repository [mixu/npm_lazy](https://github.com/mixu/npm_lazy/)).

## Usage

In order to utilize the container's service, you'll have to configure the
server's settings and also direct your local `npm` clients to use it as it's
source for registry data.

There are two ways you can use the containerized `npm_lazy` server:

- by mapping the server's port locally, exposing it within your host environment
- by linking it to other containers

### Using the server from your local host

The server defaults are configured to play nicely with local setups, i.e. when
you want the `npm` client from your host to retrieve the packages through the
cache from the running container.

The only important thing you need to do is to map the default exposed port from
the container to the same port on your host:

```
# Start a detached container, mapping the exposed port locally
sudo docker run -d -p 8080:8080 langrisha/npm-lazy
```

You can verify that the service is then accessible from your host via:

```
$ curl http://localhost:8080
{"db_name":"registry"}
```

### Linking with other containers

If you would like containers residing on your host to use the `npm_lazy`
server, give your container a hostname and add your configuration module to
the container.

Then, configure the `npm` clients on all the linked containers and configure their
registries to point to the `npm_lazy` host.

Here's a high-level overview using [`fig.sh`](http://fig.sh):

```
web:
  build: .
  links:
    - npm_lazy
npm_lazy:
  volumes:
    - ./conf/npm_lazy.js:/npm_lazy/config.js
```

## Configuring the `npm_lazy` server

The best way to configure the server is to override the configuration module on
the path `/npm_lazy/config.js`. You can also copy/volumize your own settings
elsewhere and pass the `--config /path/to/config.js` container command.

## Configuring the `npm` client

On clean installations, the `npm` client is configured to access the
official Node.js npm registry by default:

```
$ npm get registry
https://registry.npmjs.org/
```

There are several ways you can configure the `npm` client, outlined in the
[`npm_lazy` documentation](http://mixu.net/npm_lazy/#pointing_npm_to_npm_lazy).

To temporarily use the registry for an ad-hoc `npm` install:

```
RUN npm --registry http://localhost:8080/ install socket.io
```

To permanently set the registry:

```
RUN npm config set registry http://localhost:8080/
```

To permanently set the registry via config file, in `~/.npmrc`:

```
# myproject/npmrc
registry = http://localhost:8080/

# myproject/Dockerfile
FROM foo/bar

COPY npmrc /root/.npmrc
```

## Default container behavior

You'll have to pay attention to the configured server's **port**
and  **external URL**. These can be configured by supplying a valid `config.js`
module. The server's
[provided defaults](https://github.com/mixu/npm_lazy/blob/master/config.js)
configure the server to listen on *0.0.0.0:8080* and to be accessible from the
URL *http://localhost:8080*.

Make sure the networking requirements for the server are satisfied correctly
and that the server running within your container matches the details of how
it is accessed externally.

You can pass the `--show-config` container command to display the server's
runtime configuration.

## See also

- [npm_lazy project page](http://mixu.net/npm_lazy/)
- [mixu/npm_lazy repository](https://github.com/mixu/npm_lazy/)
- [configuration defaults (effectively applied)](https://github.com/mixu/npm_lazy/blob/master/config.js)
- [docker hub](https://registry.hub.docker.com/u/langrisha/npm-lazy/)
- [docker source repository](https://github.com/langri-sha/npm_lazy/)
