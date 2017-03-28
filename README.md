# Docker npm_lazy

Add this Docker container to your orchestration and enjoy near-instantaneous package dependency resolutions, courtesy of [mixu's lazy npm cache][npm_lazy] (repository [mixu/npm_lazy]).

## Usage

In order to utilize the container's service, you'll have to configure the server's settings and also direct your local `npm` clients to use it as it's source for registry data.

There are two ways you can use the containerized `npm_lazy` server:

- by mapping the server's port locally, exposing it within your host environment
- by linking it to other containers

### Using the server from your local host

The server defaults are configured to play nicely with local setups, i.e. when you want the `npm` client from your host to retrieve the packages through the cache from the running container.

The only important thing you need to do is to map the default exposed port from the container to the same port on your host:

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

If you would like containers residing on your host to use the `npm_lazy` server, give your container a hostname and add your configuration module to the container.

Then, configure the `npm` clients on all the linked containers and configure their registries to point to the `npm_lazy` host.

Here's a high-level overview using [`fig.sh`](http://fig.sh):

```
web:
  image: google/nodejs
  environment:
    - npm_config_registry=http://npmlazy
  links:
    - npmlazy
npmlazy:
  image: langrisha/npm-lazy
  command: --show-config --port=80 --external-url=http://npmlazy
```

## Configuring the `npm_lazy` server

The `npm_lazy/server` is wrapped with a thin client that allows you to dynamically configure the server from the command-line options or the environment on startup.

You can configure the server by passing arguments when starting the container.

```
$ node index.js --help

  Usage: index [options]

  Starts a dynamically configured npm_lazy server instance

  Options:

    -h, --help                             output usage information
    -V, --version                          output the version number
    --show-config                          display the effective server configuration on startup
    --logging-opts_log-to-console [value]  
    --logging-opts_log-to-file [value]
    --logging-opts_filename [value]
    --cache-directory [value]
    --cache-age [value]
    --http-timeout [value]
    --max-retries [value]
    --reject-unauthorized [value]
    --external-url [value]
    --remote-url [value]
    --port [value]
    --host [value]
    --proxy_https [value]
    --proxy_http [value]
```

### Environment variables

Any environment variables that start with `NPM_LAZY_` will be interpreted as a configuration argument. For example, putting `NPM_LAZY_PORT=80` in your environment will set the `--port` argument to `80`. Environment variables are case-sensitive, so `npm_lazy_port` will not work.

```
$ export NPM_LAZY_CACHE_DIRECTORY=/tmp/npm_lazy
$ export NPM_LAZY_EXTERNAL_URL=http://npm_lazy
$ export NPM_LAZY_PORT=80
$ node index.js
```

## Configuring the `npm` client

There are several ways you can configure the `npm` client, [outlined from official sources](https://docs.npmjs.com/misc/config).

A few great examples involve configuring the environment:

```
docker run -e npm_config_registry=http://localhost:8080 nodejsapp
```

or providing a project-specific `npmrc` file:

```
# myproj/.npmrc
registry = http://localhost:8080/
```

## Troubleshooting

You'll have to pay attention to the configured server's **port** and  **external URL**. The server's [provided defaults](https://github.com/mixu/npm_lazy/blob/master/config.js) configure the server to listen on *0.0.0.0:8080* and to be accessible from the URL *http://localhost:8080*.

Make sure the networking requirements for the server are satisfied correctly and that the server running within your container matches the details of how it is accessed externally.

You can pass the `--show-config` container command to display the server's runtime configuration. Use `npm install --verbose` to get more output from the client and make sure the hosts for the package URLs when they're looked up and downloaded always match up.

## See also

- [npm_lazy project page][npm_lazy]
- [mixu/npm_lazy repository][mixu/npm_lazy]
- [npm_lazy configuration defaults (effectively applied)][config]
- [configuring npm clients][npm-config]
- [docker hub]
- [docker source repository]

# Changelog

## [1.8.0] [latest] 2016-09-01

- Update [mixu/npm_lazy] to v1.8.0. Thanks @ralfschimmel!
- Switch to official Node.js Docker image. Thanks @ralfschimmel!
- Update Node.js version to v0.12
- Add support for configuring via environment variables #17. Thanks @StanAngeloff!
- Add basic tests

## [1.7.0] 2015-02-16

- Using Google's Node.js runtime image
- Update [mixu/npm_lazy] to v1.7
- Add usage examples
- Add support for parsing command-line arguments

## [1.0.0] 2015-01-23

- Initial release
- Use [mixu/npm_lazy] v1.7.0

[latest]: https://github.com/langri-sha/npm_lazy/compare/1.7.0...1.8.0
[1.8.0]: https://github.com/langri-sha/npm_lazy/compare/1.7.0...1.8.0
[1.7.0]: https://github.com/langri-sha/npm_lazy/compare/3f1026213161bbe3fd959e82b353e3f2013a2fed...1.7.0
[1.0.0]: https://github.com/langri-sha/npm_lazy/compare/b0d5587a136a8b87cc95578aa53714c58ec5bfb1...3f1026213161bbe3fd959e82b353e3f2013a2fed

[npm_lazy]: http://mixu.net/npm_lazy/
[mixu/npm_lazy]: https://github.com/mixu/npm_lazy
[config]: https://github.com/mixu/npm_lazy/blob/master/config.js
[npm-config]: https://docs.npmjs.com/misc/config
[docker hub]: https://registry.hub.docker.com/u/langrisha/npm-lazy/
[docker source repository]: https://github.com/langri-sha/npm_lazy/
