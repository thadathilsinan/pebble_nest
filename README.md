<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
$ cp .env.example .env
```

## Local database

**Required before the app will start, and before the e2e suite will run.** The
service verifies its database connection during boot and exits if it cannot get
one — see decision 5 in [`docs/database-decisions.md`](docs/database-decisions.md)
for why that is deliberate rather than something to work around.

```bash
$ docker compose up -d --wait   # Postgres 18, ready before it returns
$ docker compose down           # stop it; add -v to also discard the data
```

The `DATABASE_URL` in `.env.example` already points at this container. If the app
exits at startup with a message about `DATABASE_URL`, read it — the DSN is
validated field by field and the error names the part that is wrong.

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests — needs `docker compose up -d --wait` first, because these boot
# the real AppModule and it refuses to start without a database
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

The service ships as a Docker image. The `Dockerfile` builds two:

```bash
$ docker build -t pebble-api .                        # the service
$ docker build -t pebble-migrate --target migrate .   # the migration step
```

A deploy is two steps, in this order — never migrations at boot, and never two
migration runs at once (see [`docs/migrations.md`](docs/migrations.md)):

```bash
# 1. Migrate, once, to completion
$ docker run --rm -e DATABASE_URL=... pebble-migrate

# 2. Then roll out the service
$ docker run -d -p 3000:3000 --env-file prod.env pebble-api
```

Both take their configuration from the environment only — `.env` files are
excluded from the build context and never reach an image. Every variable is
listed in [`.env.example`](.env.example). The image sets `NODE_ENV=production`,
which makes the service **refuse to start** until a real mailer and the Google
client IDs are configured; the error names each one. The Apple settings may be
left unset, which turns `POST /auth/apple` off with a 503 and logs a warning.

Point the platform's health checks at:

- `GET /health/live` — liveness (the image's own `HEALTHCHECK` uses this)
- `GET /health/ready` — readiness; fails while the database is unreachable

To check the image locally, the `app` profile builds it, migrates the compose
database, and serves it on port 3001:

```bash
$ docker compose --profile app up -d --build --wait
$ curl localhost:3001/health/ready
```

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
