const sendResponse = (res, status, success, message, data = null) => {
  const response = { status, success, message };
  if (data) response.data = data;
  res.status(status).json(response);
};

module.exports = { sendResponse };
