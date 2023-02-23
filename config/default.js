
module.exports = {

   authentication: {
      entity: "user",
      service: "user",
      secret: "A3lxcjmVD0af6Hjd1fksZyzFGtE=",
      authStrategies: [
         "local"
      ],
      jwtOptions: {
         header: {
            typ: "access"
         },
         audience: "https://mitab.com",
         issuer: "feathers",
         algorithm: "HS256",
         expiresIn: "100y"
      },
      local: {
         usernameField: "pseudo",
         passwordField: "password"
      }
   },

   NODEMAILER: {
      host: "smtp.online.net",
      port: 587,
      secure: false,
      auth: {
         user: "contact@shdl.fr",
         pass: "Eurek@31",
      },
      name: "shdl.fr",
   },
}
