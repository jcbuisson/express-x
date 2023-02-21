
const nodemailer = require('nodemailer')
const config = require('config')

module.exports = {

   // returns a promise
   sendMail: function({ from, to, subject, text }) {
      // console.log('config', config, 'to', to)
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

}