module.exports = {
  signToolPath: process.env.SIGNTOOL_PATH,
  signWithParams: "/dlib " + process.env.AZURE_CODE_SIGNING_DLIB + " /dmdf " + process.env.AZURE_METADATA_JSON
};
