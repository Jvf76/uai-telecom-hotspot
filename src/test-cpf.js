import { findCustomerByCpf } from './services/ixc.js';
import { isValidCpf, onlyDigits } from './utils/cpf.js';

const cpf = onlyDigits(process.argv[2]);

if (!isValidCpf(cpf)) {
  console.error('Informe um CPF valido. Exemplo: npm run test:cpf -- 00000000000');
  process.exit(1);
}

try {
  const result = await findCustomerByCpf(cpf);
  console.log(JSON.stringify({
    found: result.found,
    active: result.active,
    id: result.customer?.id ?? null,
    razao: result.customer?.razao ?? result.customer?.nome ?? null,
    cpf: result.customer?.cnpj_cpf ?? result.customer?.cpf ?? null,
    ativo: result.customer?.ativo ?? null,
    status: result.customer?.status ?? result.customer?.situacao ?? result.customer?.status_cliente ?? null,
    cli_ativado: result.customer?.cli_ativado ?? null,
    status_internet: result.customer?.status_internet ?? null,
    statusSnapshot: result.statusSnapshot,
    availableFields: Object.keys(result.customer || {}).sort()
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
