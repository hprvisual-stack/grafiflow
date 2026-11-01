import { publicGrafiflowConfigScript } from '../server/public-config.js';

export default function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).send('Method Not Allowed');
  }

  return response.status(200).send(publicGrafiflowConfigScript());
}
