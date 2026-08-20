
import numpy as np

def newton_solve(F, x0, J=None, tol=1e-9, max_iter=50, damping=False):

    x = np.array(x0, dtype=float)
    residual_history = []

    for i in range(max_iter):
        Fx = np.array(F(x))
        normF = np.linalg.norm(Fx)
        residual_history.append(normF)

        # Convergence Check
        if normF < tol:
            return x, {
                "success": True,
                "iterations": i,
                "residual": normF,
                "residual_history": residual_history
            }

        # Compute Jacobian numerically (unless given)
        if J is None:
            eps = 1e-8
            n = len(x)
            J_approx = np.zeros((n, n))
            for j in range(n):
                dx = np.zeros(n)
                dx[j] = eps
                J_approx[:, j] = (np.array(F(x + dx)) - Fx) / eps
            Jx = J_approx
        else:
            Jx = np.array(J(x))

        # Solve for the step
        dx = np.linalg.solve(Jx, -Fx)

        # Optional damping
        if damping:
            x = x + 0.5 * dx
        else:
            x = x + dx

    # Failure to converge
    return x, {
        "success": False,
        "iterations": max_iter,
        "residual": normF,
        "residual_history": residual_history
    }