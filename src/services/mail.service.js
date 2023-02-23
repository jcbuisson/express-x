
const nodemailer = require('nodemailer')
const config = require('config')


module.exports = function (app) {

   app.createCustomService({
      name: 'mailer',
      create: ({ from, to, subject, text }) => {
         try {
            const transporter = nodemailer.createTransport(config.NODEMAILER)
            return transporter.sendMail({
               from,
               to,
               subject,
               text,
               html: text,
            })
         } catch(err) {
            console.log('err mail', err)
         }
      },
   })
}
