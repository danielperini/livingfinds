import KickoffScheduledModal from './KickoffScheduledModal';

export default function KickoffModal({
  product,
  onDone,
  onClose,
  ...props
}) {
  /*
   * Quando o Kick-off for salvo,
   * avisa a página Produtos para
   * consultar a fila imediatamente.
   *
   * A modal continua aberta para
   * mostrar a confirmação.
   */
  const handleQueued = () => {
    window.dispatchEvent(
      new CustomEvent(
        'product-kickoff-queued',
        {
          detail: {
            asin:
              product?.asin || null,
          },
        }
      )
    );
  };

  /*
   * A modal só fecha quando o usuário
   * clicar no X ou no botão Fechar.
   */
  const handleClose = () => {
    if (onDone) {
      onDone();
      return;
    }

    onClose?.();
  };

  return (
    <KickoffScheduledModal
      {...props}
      product={product}
      onDone={handleQueued}
      onClose={handleClose}
    />
  );
}